import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, StatsGroupBy, StatsPeriod } from "./db.js";
import { extractUsage, StreamUsageCollector, type ApiType, type NormalizedUsage } from "./usage.js";
import { changeLoginPassword, checkLogin, ensureLoginPassword, passwordIsDefault, SESSION_TTL_MS } from "./auth.js";

export interface ServerOptions {
  db: Db;
  publicDir?: string;
  fetchFn?: typeof fetch;
}

const PATH_API: Record<string, ApiType> = {
  "/v1/chat/completions": "openai-completions",
  "/v1/responses": "openai-responses",
  "/v1/messages": "anthropic-messages",
};
const API_PATH: Record<ApiType, string> = {
  "openai-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
};
const STATIC: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const SESSION_COOKIE = "1router_session";

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const errBody = (message: string, type = "invalid_request_error") => ({ error: { message, type } });

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return null; }
}

function cookieValue(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/** Upstream key is never sent to the browser in full. */
const maskKey = (k: string) => (k ? `••••${k.slice(-4)}` : "");
export const publicProvider = (p: ReturnType<Db["listProviders"]>[number]) => ({
  id: p.id, slug: p.slug, name: p.name, baseUrl: p.baseUrl, api: p.api,
  models: p.models, apiKeyMasked: maskKey(p.apiKey), createdAt: p.createdAt,
});

export function createServer(opts: ServerOptions): http.Server {
  const { db } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const publicDir = opts.publicDir ?? fileURLToPath(new URL("../../public", import.meta.url));
  ensureLoginPassword(db);

  const clientSecret = (req: http.IncomingMessage): string => {
    const auth = req.headers.authorization;
    if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
    const x = req.headers["x-api-key"];
    return typeof x === "string" ? x : "";
  };
  const authenticateKey = (req: http.IncomingMessage) => db.findKeyBySecret(clientSecret(req));
  const hasSession = (req: http.IncomingMessage) => db.findSession(cookieValue(req, SESSION_COOKIE)) !== null;

  const serveFile = async (res: http.ServerResponse, name: string) => {
    try {
      const file = await readFile(join(publicDir, name));
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "text/plain" });
      res.end(file);
    } catch { json(res, 404, errBody("Not found", "not_found")); }
  };

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, expectedApi: ApiType) {
    const key = authenticateKey(req);
    if (!key) return json(res, 401, errBody("Invalid or missing 1Router API key. Create one in the web dashboard (API Keys tab) — do not use your provider key here.", "authentication_error"));

    const body = await readJson(req);
    if (!body) return json(res, 400, errBody("Request body must be JSON"));
    const target = typeof body.model === "string" ? db.resolveModel(body.model) : null;
    if (!target) return json(res, 400, errBody(`Unknown model: ${String(body.model)}. Use "<provider>/<model>" exactly as shown in the dashboard Providers tab.`));
    if (target.api !== expectedApi) {
      return json(res, 400, errBody(`Model ${body.model} is a ${target.api} model, but this endpoint is ${expectedApi}. Use the endpoint for its type (see How to Use).`));
    }

    const streaming = body.stream === true;
    const upstreamBody = target.api === "openai-completions" && streaming
      ? { ...body, model: target.modelId, stream_options: { ...(body.stream_options ?? {}), include_usage: true } }
      : { ...body, model: target.modelId };
    const started = Date.now();

    const record = (usage: NormalizedUsage | null, httpStatus: number) => {
      try {
        db.insertEvent({
          ts: Date.now(), clientKeyId: key.id, provider: target.provider, model: target.modelId, api: target.api,
          input: usage?.input ?? 0, output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0,
          httpStatus, streaming, latencyMs: Date.now() - started, usageMissing: usage === null,
        });
      } catch { /* counting must never break the proxy */ }
    };

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || ["host", "content-length", "connection", "authorization", "x-api-key", "cookie"].includes(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["content-type"] = "application/json";
    if (target.apiKey) {
      if (target.api === "anthropic-messages") headers["x-api-key"] = target.apiKey;
      else headers["authorization"] = `Bearer ${target.apiKey}`;
    }

    let upstream: Response;
    try {
      upstream = await fetchFn(target.baseUrl + API_PATH[target.api], { method: "POST", headers, body: JSON.stringify(upstreamBody) });
    } catch (e) {
      record(null, 502);
      return json(res, 502, errBody(`Could not reach provider "${target.provider}" (${target.baseUrl}): ${(e as Error).message}`, "upstream_error"));
    }

    const resHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      // fetch() already decompressed the body, so content-encoding would make
      // browsers fail with "Failed to fetch"; upstream cookies are not ours to set.
      if (!["content-length", "transfer-encoding", "connection", "content-encoding", "set-cookie"].includes(k)) resHeaders[k] = v;
    });

    if (streaming && upstream.body) {
      res.writeHead(upstream.status, resHeaders);
      const collector = new StreamUsageCollector(target.api);
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          collector.push(decoder.decode(value, { stream: true }));
          if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
        }
      } catch { /* aborted: record what we saw */ }
      record(upstream.ok ? collector.result() : null, upstream.status);
      res.end();
      return;
    }

    const text = await upstream.text();
    let usage: NormalizedUsage | null = null;
    if (upstream.ok) { try { usage = extractUsage(target.api, JSON.parse(text)); } catch { /* non-JSON */ } }
    record(usage, upstream.status);
    res.writeHead(upstream.status, resHeaders);
    res.end(text);
  }

  async function fetchModels(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    if (!body) return json(res, 400, errBody("Body must be JSON"));
    let apiKey: string = body.apiKey ?? "";
    const baseUrl = String(body.baseUrl ?? "").replace(/\/+$/, "");
    const api = body.api as ApiType;
    if (!baseUrl) return json(res, 400, errBody("baseUrl is required"));
    // blank key + known provider -> use the stored key (when editing)
    if (!apiKey && body.providerId) {
      const p = db.getProvider(Number(body.providerId));
      if (p) apiKey = p.apiKey;
    }
    const headers: Record<string, string> = {};
    if (apiKey) {
      if (api === "anthropic-messages") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
      else headers["authorization"] = `Bearer ${apiKey}`;
    }
    try {
      const r = await fetchFn(baseUrl + "/models", { headers });
      const text = await r.text();
      if (!r.ok) return json(res, 400, errBody(`Upstream /models returned ${r.status}: ${text.slice(0, 200)}`));
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.data ?? data.models ?? [];
      const models = list.map((m: any) => (typeof m === "string" ? m : m.id ?? m.name)).filter(Boolean);
      return json(res, 200, { models });
    } catch (e) {
      return json(res, 400, errBody(`Could not fetch models from ${baseUrl}/models: ${(e as Error).message}`));
    }
  }

  /**
   * Server-side "Try it now": performs a real request through this server's own
   * proxy pipeline (loopback), so the browser only ever talks JSON to /api/*
   * and gets a friendly { ok, status, message } instead of a raw fetch error.
   */
  async function testRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readJson(req);
    if (!body) return json(res, 400, errBody("Body must be JSON"));
    const suppliedKey = String(body.clientKey ?? body.apiKey ?? "");
    if (!db.findKeyBySecret(suppliedKey)) {
      return json(res, 200, { ok: false, status: 401, message: "That API key was not recognized. Paste a key from the API Keys tab (it starts with sk-1r-), not your provider key." });
    }
    const target = typeof body.model === "string" ? db.resolveModel(body.model) : null;
    if (!target) {
      return json(res, 200, { ok: false, status: 400, message: `Unknown model: ${String(body.model)}. Use "<provider>/<model>" exactly as shown in the Providers tab.` });
    }
    const payload =
      target.api === "anthropic-messages"
        ? { model: body.model, max_tokens: 50, messages: [{ role: "user", content: "Say hi in 3 words" }] }
        : target.api === "openai-responses"
          ? { model: body.model, input: "Say hi in 3 words" }
          : { model: body.model, messages: [{ role: "user", content: "Say hi in 3 words" }] };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (target.api === "anthropic-messages") { headers["x-api-key"] = suppliedKey; headers["anthropic-version"] = "2023-06-01"; }
    else headers["authorization"] = `Bearer ${suppliedKey}`;
    const port = req.socket.localPort;
    const addr = req.socket.localAddress ?? "127.0.0.1";
    const host = addr.includes(":") ? `[${addr}]` : addr;
    const started = Date.now();
    try {
      const r = await fetchFn(`http://${host}:${port}/v1${API_PATH[target.api]}`, {
        method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      let detail = text.slice(0, 400);
      try { detail = JSON.parse(text)?.error?.message ?? detail; } catch { /* keep raw preview */ }
      return json(res, 200, {
        ok: r.ok, status: r.status, latencyMs: Date.now() - started,
        message: r.ok ? "It worked — this request was counted. Open the Dashboard tab to see it." : `The provider answered HTTP ${r.status}: ${detail}`,
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      return json(res, 200, {
        ok: false, status: null, latencyMs: Date.now() - started,
        message: timedOut
          ? "Timed out after 60 seconds waiting for the provider. Check the provider Base URL in the Providers tab, and that the provider is reachable."
          : `Could not complete the request through 1Router: ${(e as Error).message}`,
      });
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });

      // ---- login (public) ----
      if (req.method === "GET" && path === "/login") {
        if (hasSession(req)) { res.writeHead(302, { location: "/" }); return res.end(); }
        return serveFile(res, "login.html");
      }
      if (req.method === "POST" && path === "/api/login") {
        const body = await readJson(req);
        if (!body || !checkLogin(db, String(body.password ?? ""))) {
          return json(res, 401, errBody("Wrong password", "authentication_error"));
        }
        const s = db.createSession(SESSION_TTL_MS);
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `${SESSION_COOKIE}=${s.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        return res.end(JSON.stringify({ ok: true, passwordIsDefault: passwordIsDefault(db) }));
      }
      if (req.method === "POST" && path === "/api/logout") {
        db.deleteSession(cookieValue(req, SESSION_COOKIE));
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
        return res.end(JSON.stringify({ ok: true }));
      }

      // ---- static web app (login required) ----
      if (req.method === "GET" && path in STATIC) {
        if (!hasSession(req)) {
          if (path === "/" || path === "/index.html") { res.writeHead(302, { location: "/login" }); return res.end(); }
          return json(res, 401, errBody("Login required", "authentication_error"));
        }
        return serveFile(res, STATIC[path]);
      }

      // ---- proxy endpoints (client API key) ----
      if (req.method === "GET" && path === "/v1/models") {
        if (!authenticateKey(req)) return json(res, 401, errBody("Invalid or missing 1Router API key", "authentication_error"));
        return json(res, 200, { object: "list", data: db.listModels().map((m) => ({ id: m.id, object: "model", owned_by: m.provider })) });
      }
      if (req.method === "POST" && path in PATH_API) return await proxy(req, res, PATH_API[path]);

      // ---- admin API (dashboard session only) ----
      const isAdmin = path.startsWith("/api/");
      if (isAdmin) {
        if (!hasSession(req)) return json(res, 401, errBody("Login required", "authentication_error"));

        if (req.method === "GET" && path === "/api/me") {
          return json(res, 200, { authenticated: true, passwordIsDefault: passwordIsDefault(db) });
        }
        if (req.method === "POST" && path === "/api/test-request") return await testRequest(req, res);
        if (req.method === "GET" && path === "/api/export") {
          const bytes = db.serialize();
          const filename = `1router-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.db`;
          res.writeHead(200, {
            "content-type": "application/vnd.sqlite3",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-length": bytes.length,
          });
          return res.end(bytes);
        }
        if (req.method === "POST" && path === "/api/change-password") {
          const body = await readJson(req);
          const next = String(body?.newPassword ?? "");
          if (next.length < 6) return json(res, 400, errBody("New password must be at least 6 characters"));
          if (!changeLoginPassword(db, String(body?.currentPassword ?? ""), next)) {
            return json(res, 400, errBody("Current password is wrong"));
          }
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && path === "/api/stats") {
          const period = (url.searchParams.get("period") ?? "daily") as StatsPeriod;
          const groupBy = (url.searchParams.get("groupBy") ?? "provider") as StatsGroupBy;
          if (!["daily", "weekly", "monthly", "yearly", "all"].includes(period)) return json(res, 400, errBody("Invalid period"));
          if (!["key", "provider", "model"].includes(groupBy)) return json(res, 400, errBody("Invalid groupBy"));
          return json(res, 200, db.stats({ period, groupBy }));
        }
        if (req.method === "GET" && path === "/api/requests") {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
          return json(res, 200, db.recentEvents(limit));
        }
        if (req.method === "GET" && path === "/api/providers") return json(res, 200, db.listProviders().map(publicProvider));
        if (req.method === "POST" && path === "/api/providers") {
          const body = await readJson(req);
          if (!body) return json(res, 400, errBody("Body must be JSON"));
          try {
            const p = db.createProvider({
              slug: String(body.slug ?? ""), name: String(body.name ?? ""), baseUrl: String(body.baseUrl ?? ""),
              api: body.api, apiKey: String(body.apiKey ?? ""), models: Array.isArray(body.models) ? body.models.map(String) : [],
            });
            return json(res, 201, publicProvider(p));
          } catch (e) { return json(res, 400, errBody((e as Error).message)); }
        }
        if (req.method === "POST" && path === "/api/providers/fetch-models") return await fetchModels(req, res);
        const providerIdMatch = path.match(/^\/api\/providers\/(\d+)$/);
        if (providerIdMatch && req.method === "PUT") {
          const body = await readJson(req);
          if (!body) return json(res, 400, errBody("Body must be JSON"));
          try {
            const patch: Record<string, unknown> = {};
            for (const k of ["slug", "name", "baseUrl", "api", "apiKey"] as const) if (body[k] !== undefined) patch[k] = String(body[k]);
            if (body.models !== undefined) patch.models = Array.isArray(body.models) ? body.models.map(String) : [];
            return json(res, 200, publicProvider(db.updateProvider(Number(providerIdMatch[1]), patch as any)));
          } catch (e) { return json(res, 400, errBody((e as Error).message)); }
        }
        if (providerIdMatch && req.method === "DELETE") {
          db.deleteProvider(Number(providerIdMatch[1]));
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && path === "/api/keys") return json(res, 200, db.listKeys());
        if (req.method === "POST" && path === "/api/keys") {
          const body = await readJson(req);
          const created = db.createKey(String(body?.name ?? "unnamed").slice(0, 100) || "unnamed");
          return json(res, 200, created); // plaintext shown exactly once, here
        }
        const keyIdMatch = path.match(/^\/api\/keys\/(\d+)$/);
        if (keyIdMatch && req.method === "DELETE") {
          db.revokeKey(Number(keyIdMatch[1]));
          return json(res, 200, { ok: true });
        }
      }

      return json(res, 404, errBody("Not found", "not_found"));
    } catch (e) {
      return json(res, 500, errBody(`Internal error: ${(e as Error).message}`, "internal_error"));
    }
  });
}
