import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, ModelMeta, StatsGroupBy, StatsPeriod } from "./db.js";
import { extractUsage, StreamUsageCollector, type ApiType, type NormalizedUsage } from "./usage.js";
import { capabilityFor } from "./reasoning.js";
import { changeLoginPassword, checkLogin, ensureLoginPassword, passwordIsDefault, SESSION_TTL_MS } from "./auth.js";

export interface ServerOptions {
  db: Db;
  publicDir?: string;
  fetchFn?: typeof fetch;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  proxyTimeoutMs?: number;
  loginWindowMs?: number;
  loginMaxFailures?: number;
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
const DEFAULT_MAX_BODY = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE = 64 * 1024 * 1024;
const DEFAULT_PROXY_TIMEOUT = 300_000;
const LOGIN_WINDOW = 10 * 60_000;
const LOGIN_MAX_FAILURES = 10;

const errBody = (message: string, type = "invalid_request_error") => ({ error: { message, type } });

function securityHeaders(res: http.ServerResponse): void {
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  securityHeaders(res);
  if (!res.hasHeader("cache-control")) res.setHeader("cache-control", "no-store");
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

class PayloadTooLargeError extends Error {}
const readBytes = async (req: http.IncomingMessage, max: number): Promise<Buffer> => {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new PayloadTooLargeError(`Request body exceeds ${max} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) throw new PayloadTooLargeError(`Request body exceeds ${max} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
};

async function readJson(req: http.IncomingMessage, max: number): Promise<any> {
  const bytes = await readBytes(req, max);
  try { return JSON.parse(bytes.toString("utf8") || "{}"); }
  catch { return null; }
}

async function readResponseText(response: Response, max: number): Promise<{ text: string; overflow: boolean }> {
  if (!response.body) return { text: await response.text(), overflow: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0, overflow = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > max) { overflow = true; await reader.cancel().catch(() => {}); break; }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, overflow };
}

function cookieValue(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/** Upstream key is never sent to the browser in full. A short key is fully hidden. */
export const maskKey = (k: string) => (k.length >= 8 ? `••••${k.slice(-4)}` : "••••");

export function publicProvider(p: ReturnType<Db["listProviders"]>[number]) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api,
    models: p.models.map((m: ModelMeta) => {
      const cap = capabilityFor(p.slug, m.modelId, m);
      return { modelId: m.modelId, id: m.modelId, imageInput: m.imageInput, thinking: m.thinking, reasoning: cap.reasoning, defaultEffort: cap.defaultEffort };
    }),
    apiKeyMasked: maskKey(p.apiKey),
    createdAt: p.createdAt,
  };
}

function stripThinking(api: ApiType, body: any): any {
  const out = { ...body };
  delete out.reasoning;
  delete out.reasoning_effort;
  if (api === "anthropic-messages") {
    delete out.thinking;
    if (out.output_config && typeof out.output_config === "object") {
      const outputConfig = { ...out.output_config };
      delete outputConfig.effort;
      out.output_config = outputConfig;
    }
  }
  return out;
}

function requestEffort(api: ApiType, body: any): string {
  const check = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (api === "openai-completions") return check(body?.reasoning_effort) ?? check(body?.reasoning?.effort) ?? "provider";
  if (api === "openai-responses") return check(body?.reasoning?.effort) ?? check(body?.reasoning_effort) ?? "provider";
  const effort = check(body?.output_config?.effort) ?? check(body?.reasoning?.effort) ?? check(body?.reasoning_effort);
  if (effort) return effort;
  if (body?.thinking?.type === "enabled" && typeof body.thinking.budget_tokens === "number") return `budget:${body.thinking.budget_tokens}`;
  if (body?.thinking?.budget_tokens) return `budget:${body.thinking.budget_tokens}`;
  if (body?.thinking?.type) return String(body.thinking.type);
  return "provider";
}

function containsImage(api: ApiType, body: any): boolean {
  const seen = new Set<any>();
  const visit = (v: any): boolean => {
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some(visit);
    const type = typeof v.type === "string" ? v.type.toLowerCase() : "";
    if (type === "image" || type === "image_url" || type === "input_image") return true;
    if (typeof v.image_url === "string") return true;
    if (v.image_url && typeof v.image_url === "object" && typeof v.image_url.url === "string") return true;
    if (v.source && typeof v.source === "object" && (v.source.media_type === "image/png" || v.source.media_type === "image/jpeg" || String(v.source.media_type ?? "").startsWith("image/"))) return true;
    return Object.values(v).some(visit);
  };
  if (api === "anthropic-messages") return visit(body?.messages ?? body);
  if (api === "openai-responses") return visit(body?.input ?? body?.messages ?? body);
  return visit(body?.messages ?? body);
}

export function createServer(opts: ServerOptions): http.Server {
  const { db } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const publicDir = opts.publicDir ?? fileURLToPath(new URL("../../public", import.meta.url));
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxResponse = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE;
  const proxyTimeout = opts.proxyTimeoutMs ?? DEFAULT_PROXY_TIMEOUT;
  const loginWindow = opts.loginWindowMs ?? LOGIN_WINDOW;
  const loginMaxFailures = opts.loginMaxFailures ?? LOGIN_MAX_FAILURES;
  ensureLoginPassword(db);
  db.pruneExpiredSessions();
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

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
      securityHeaders(res);
      res.setHeader("cache-control", "no-cache");
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "text/plain" });
      res.end(file);
    } catch { json(res, 404, errBody("Not found", "not_found")); }
  };

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, expectedApi: ApiType) {
    const key = authenticateKey(req);
    if (!key) return json(res, 401, errBody("Invalid or missing 1Router API key. Create one in the web dashboard (API Keys tab) — do not use your provider key here.", "authentication_error"));

    let body: any;
    try { body = await readJson(req, maxBody); }
    catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
    if (!body) return json(res, 400, errBody("Request body must be JSON"));
    const target = typeof body.model === "string" ? db.resolveModel(body.model) : null;
    if (!target) return json(res, 400, errBody(`Unknown model: ${String(body.model)}. Use "<provider>/<model>" exactly as shown in the dashboard Providers tab.`));
    if (target.api !== expectedApi) {
      return json(res, 400, errBody(`Model ${body.model} is a ${target.api} model, but this endpoint is ${expectedApi}. Use the endpoint for its type (see How to Use).`));
    }
    if (containsImage(target.api, body) && !target.imageInput) {
      return json(res, 400, errBody(`Model ${body.model} is not marked as image-capable in 1Router. Enable Images for it in Providers first — 1Router blocks image input unless explicitly allowed.`));
    }

    const thinkingDisabled = target.thinking !== true;
    const effectiveBody = thinkingDisabled ? stripThinking(target.api, body) : body;
    const streaming = effectiveBody.stream === true;
    const upstreamBody = target.api === "openai-completions" && streaming
      ? { ...effectiveBody, model: target.modelId, stream_options: { ...(effectiveBody.stream_options ?? {}), include_usage: true } }
      : { ...effectiveBody, model: target.modelId };
    const effort = thinkingDisabled ? "none" : requestEffort(target.api, effectiveBody);
    const started = Date.now();
    let recorded = false;

    const record = (usage: NormalizedUsage | null, httpStatus: number) => {
      if (recorded) return;
      recorded = true;
      try {
        db.insertEvent({
          ts: Date.now(), clientKeyId: key.id, provider: target.provider, model: target.modelId, api: target.api,
          input: usage?.input ?? 0, output: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0,
          httpStatus, streaming, latencyMs: Date.now() - started, usageMissing: usage === null, effort,
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), proxyTimeout);
    const abortDownstream = () => controller.abort();
    req.once("aborted", abortDownstream);
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });

    let upstream: Response;
    try {
      upstream = await fetchFn(target.baseUrl + API_PATH[target.api], {
        method: "POST", headers, body: JSON.stringify(upstreamBody), signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      const aborted = controller.signal.aborted;
      record(null, aborted ? 499 : 502);
      if (!res.destroyed && !res.writableEnded) {
        return json(res, aborted ? 502 : 502, errBody(aborted ? "The request was cancelled or timed out before the provider answered." : `Could not reach provider "${target.provider}" (${target.baseUrl}): ${(e as Error).message}`, "upstream_error"));
      }
      return;
    }

    const resHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!["content-length", "transfer-encoding", "connection", "content-encoding", "set-cookie"].includes(k)) resHeaders[k] = v;
    });

    const reader = upstream.body?.getReader();
    if (!reader) {
      clearTimeout(timeout);
      const text = await upstream.text();
      let usage: NormalizedUsage | null = null;
      if (upstream.ok) { try { usage = extractUsage(target.api, JSON.parse(text)); } catch { /* non-JSON */ } }
      record(usage, upstream.status);
      if (!res.destroyed) { res.writeHead(upstream.status, resHeaders); res.end(text); }
      return;
    }

    res.writeHead(upstream.status, resHeaders);
    const collector = new StreamUsageCollector(target.api);
    const decoder = new TextDecoder();
    let observedBytes = 0;
    let observedText = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) { await reader.cancel().catch(() => {}); break; }
        if (streaming) {
          collector.push(decoder.decode(value, { stream: true }));
        } else {
          observedBytes += value.length;
          if (observedBytes > maxResponse) {
            await reader.cancel().catch(() => {});
            throw new Error(`Upstream response exceeds ${maxResponse} bytes`);
          }
          observedText += decoder.decode(value, { stream: true });
        }
        if (res.destroyed || res.writableEnded) { await reader.cancel().catch(() => {}); break; }
        if (!res.write(Buffer.from(value))) await new Promise((r) => res.once("drain", r));
      }
    } catch (e) {
      clearTimeout(timeout);
      if (!streaming && observedBytes > maxResponse) {
        record(null, 502);
        return;
      }
      // Client disconnect/upstream abort: record what was observed below.
    } finally {
      clearTimeout(timeout);
      let usage: NormalizedUsage | null = null;
      if (upstream.ok) {
        if (streaming) usage = collector.result();
        else { try { usage = extractUsage(target.api, JSON.parse(observedText + decoder.decode())); } catch { /* non-JSON */ } }
      }
      record(usage, upstream.status);
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }

  async function fetchModels(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: any;
    try { body = await readJson(req, 100_000); }
    catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
    if (!body) return json(res, 400, errBody("Body must be JSON"));
    let apiKey: string = body.apiKey ?? "";
    const baseUrl = String(body.baseUrl ?? "").replace(/\/+$/, "");
    const api = body.api as ApiType;
    if (!baseUrl) return json(res, 400, errBody("baseUrl is required"));
    if (!apiKey && body.providerId) {
      const p = db.getProvider(Number(body.providerId));
      if (p) apiKey = p.apiKey;
    }
    const headers: Record<string, string> = {};
    if (apiKey) {
      if (api === "anthropic-messages") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
      else headers["authorization"] = `Bearer ${apiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const r = await fetchFn(baseUrl + "/models", { headers, signal: controller.signal });
      const { text, overflow } = await readResponseText(r, 2 * 1024 * 1024);
      if (overflow) return json(res, 400, errBody("Upstream /models response was too large to read."));
      if (!r.ok) return json(res, 400, errBody(`Upstream /models returned ${r.status}: ${text.slice(0, 200)}`));
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.data ?? data.models ?? [];
      const models = list.map((m: any) => {
        const modelId = typeof m === "string" ? m : m.id ?? m.name;
        if (!modelId) return null;
        return { modelId, id: modelId, imageInput: null, thinking: null, reasoning: null };
      }).filter(Boolean);
      return json(res, 200, { models });
    } catch (e) {
      const timedOut = (e as Error).name === "AbortError" || (e as Error).name === "TimeoutError";
      return json(res, 400, errBody(timedOut ? `Timed out fetching models from ${baseUrl}/models after 15 seconds.` : `Could not fetch models from ${baseUrl}/models: ${(e as Error).message}`));
    } finally { clearTimeout(timer); }
  }

  async function testRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: any;
    try { body = await readJson(req, 100_000); }
    catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
    if (!body) return json(res, 400, errBody("Body must be JSON"));
    const suppliedKey = String(body.clientKey ?? body.apiKey ?? "");
    if (!db.findKeyBySecret(suppliedKey)) {
      return json(res, 200, { ok: false, status: 401, message: "That API key was not recognized. Paste a key from the API Keys tab (it starts with sk-1r-), not your provider key." });
    }
    const target = typeof body.model === "string" ? db.resolveModel(body.model) : null;
    if (!target) {
      return json(res, 200, { ok: false, status: 400, message: `Unknown model: ${String(body.model)}. Use "<provider>/<model>" exactly as shown in the Providers tab.` });
    }
    const thinkingLevel = typeof body.thinkingLevel === "string" ? body.thinkingLevel : null;
    const validLevels = ["minimal", "low", "medium", "high", "xhigh", "max"];
    if (thinkingLevel && !validLevels.includes(thinkingLevel)) {
      return json(res, 200, { ok: false, status: 400, message: `Unknown thinking level: ${thinkingLevel}. Choose minimal, low, medium, high, xhigh, or max.` });
    }
    const payload: Record<string, unknown> =
      target.api === "anthropic-messages"
        ? { model: body.model, max_tokens: thinkingLevel ? 1024 : 50, messages: [{ role: "user", content: "Say hi in 3 words" }] }
        : target.api === "openai-responses"
          ? { model: body.model, input: "Say hi in 3 words" }
          : { model: body.model, messages: [{ role: "user", content: "Say hi in 3 words" }] };
    if (thinkingLevel) {
      if (target.api === "anthropic-messages") payload.thinking = { type: "enabled", budget_tokens: 1024 };
      else if (target.api === "openai-responses") payload.reasoning = { effort: thinkingLevel };
      else payload.reasoning_effort = thinkingLevel;
    }
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
      const { text } = await readResponseText(r, maxResponse);
      let detail = text.slice(0, 400);
      try { detail = JSON.parse(text)?.error?.message ?? detail; } catch { /* keep raw preview */ }
      return json(res, 200, {
        ok: r.ok, status: r.status, latencyMs: Date.now() - started,
        message: r.ok
          ? thinkingLevel
            ? `It worked — the provider accepted thinking level “${thinkingLevel}”. Now enable that level for this model in Providers if you want it in Pi. This request was counted.`
            : "It worked — this request was counted. Open the Dashboard tab to see it."
          : `The provider answered HTTP ${r.status}: ${detail}`,
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

  async function providerBody(req: http.IncomingMessage) {
    return readJson(req, maxBody);
  }

  function parseProviderModels(body: any): { models: string[]; modelMeta: ModelMeta[] } {
    if (!Array.isArray(body?.models)) return { models: [], modelMeta: [] };
    const models: string[] = [];
    const modelMeta: ModelMeta[] = [];
    for (const m of body.models) {
      if (typeof m === "string") { if (m.trim() && !models.includes(m.trim())) models.push(m.trim()); continue; }
      if (m && typeof m === "object" && typeof m.id === "string") {
        const id = m.id.trim();
        if (!id) continue;
        if (!models.includes(id)) models.push(id);
        const levels = Array.isArray(m.reasoning?.levels) ? m.reasoning.levels : null;
        const meta: ModelMeta = {
          modelId: id,
          imageInput: m.imageInput === true ? true : m.imageInput === false ? false : null,
          thinking: m.thinking === true ? true : m.thinking === false ? false : null,
          reasoning: m.thinking === true && levels ? { levels, defaultLevel: m.defaultEffort ?? m.reasoning?.defaultLevel ?? "provider", source: "manual" } : null,
        };
        const existing = modelMeta.findIndex((x) => x.modelId === id);
        if (existing >= 0) modelMeta[existing] = meta; else modelMeta.push(meta);
      }
    }
    return { models, modelMeta };
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });

      if (req.method === "GET" && path === "/login") {
        if (hasSession(req)) { res.writeHead(302, { location: "/" }); return res.end(); }
        return serveFile(res, "login.html");
      }
      if (req.method === "POST" && path === "/api/login") {
        let body: any;
        try { body = await readJson(req, 100_000); }
        catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
        const ip = req.socket.remoteAddress ?? "unknown";
        const fail = loginFailures.get(ip);
        if (fail && fail.resetAt > Date.now() && fail.count >= loginMaxFailures) {
          return json(res, 429, errBody("Too many failed login attempts. Wait a few minutes and try again.", "rate_limit_error"));
        }
        if (!body || !checkLogin(db, String(body.password ?? ""))) {
          const state = fail && fail.resetAt > Date.now() ? fail : { count: 0, resetAt: Date.now() + loginWindow };
          state.count++;
          loginFailures.set(ip, state);
          const status = state.count > loginMaxFailures ? 429 : 401;
          return json(res, status, errBody(status === 429 ? "Too many failed login attempts. Wait a few minutes and try again." : "Wrong password", status === 429 ? "rate_limit_error" : "authentication_error"));
        }
        loginFailures.delete(ip);
        const s = db.createSession(SESSION_TTL_MS);
        securityHeaders(res);
        res.setHeader("cache-control", "no-store");
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `${SESSION_COOKIE}=${s.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
        return res.end(JSON.stringify({ ok: true, passwordIsDefault: passwordIsDefault(db) }));
      }
      if (req.method === "POST" && path === "/api/logout") {
        db.deleteSession(cookieValue(req, SESSION_COOKIE));
        securityHeaders(res);
        res.setHeader("cache-control", "no-store");
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
        return res.end(JSON.stringify({ ok: true }));
      }

      if (req.method === "GET" && path in STATIC) {
        if (!hasSession(req)) {
          if (path === "/" || path === "/index.html") { res.writeHead(302, { location: "/login" }); return res.end(); }
          return json(res, 401, errBody("Login required", "authentication_error"));
        }
        return serveFile(res, STATIC[path]);
      }

      if (req.method === "GET" && path === "/v1/models") {
        if (!authenticateKey(req)) return json(res, 401, errBody("Invalid or missing 1Router API key", "authentication_error"));
        return json(res, 200, { object: "list", data: db.listModels().map((m) => ({ id: m.id, object: "model", owned_by: m.provider })) });
      }
      if (req.method === "POST" && path in PATH_API) return await proxy(req, res, PATH_API[path]);

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
          securityHeaders(res);
          res.setHeader("cache-control", "no-store");
          res.writeHead(200, {
            "content-type": "application/vnd.sqlite3",
            "content-disposition": `attachment; filename="${filename}"`,
            "content-length": bytes.length,
          });
          return res.end(bytes);
        }
        if (req.method === "POST" && path === "/api/change-password") {
          let body: any;
          try { body = await readJson(req, 100_000); }
          catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
          const next = String(body?.newPassword ?? "");
          if (next.length < 6) return json(res, 400, errBody("New password must be at least 6 characters"));
          if (!changeLoginPassword(db, String(body?.currentPassword ?? ""), next)) {
            return json(res, 400, errBody("Current password is wrong"));
          }
          db.deleteAllSessions();
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
          let body: any;
          try { body = await providerBody(req); }
          catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
          if (!body) return json(res, 400, errBody("Body must be JSON"));
          try {
            const parsed = parseProviderModels(body);
            const p = db.createProvider({
              slug: String(body.slug ?? ""), name: String(body.name ?? ""), baseUrl: String(body.baseUrl ?? ""),
              api: body.api, apiKey: String(body.apiKey ?? ""), models: parsed.models, modelMeta: parsed.modelMeta,
            });
            return json(res, 201, publicProvider(p));
          } catch (e) { return json(res, 400, errBody((e as Error).message)); }
        }
        if (req.method === "POST" && path === "/api/providers/fetch-models") return await fetchModels(req, res);
        const providerIdMatch = path.match(/^\/api\/providers\/(\d+)$/);
        if (providerIdMatch && req.method === "PUT") {
          let body: any;
          try { body = await providerBody(req); }
          catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
          if (!body) return json(res, 400, errBody("Body must be JSON"));
          try {
            const patch: Record<string, unknown> = {};
            for (const k of ["slug", "name", "baseUrl", "api", "apiKey"] as const) if (body[k] !== undefined) patch[k] = String(body[k]);
            if (body.models !== undefined) {
              const parsed = parseProviderModels(body);
              patch.models = parsed.models;
              patch.modelMeta = parsed.modelMeta;
            }
            return json(res, 200, publicProvider(db.updateProvider(Number(providerIdMatch[1]), patch as any)));
          } catch (e) { return json(res, 400, errBody((e as Error).message)); }
        }
        if (providerIdMatch && req.method === "DELETE") {
          db.deleteProvider(Number(providerIdMatch[1]));
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && path === "/api/keys") return json(res, 200, db.listKeys());
        if (req.method === "POST" && path === "/api/keys") {
          let body: any;
          try { body = await readJson(req, 100_000); }
          catch (e) { if (e instanceof PayloadTooLargeError) return json(res, 413, errBody("Request body is too large.")); throw e; }
          const created = db.createKey(String(body?.name ?? "unnamed").slice(0, 100) || "unnamed");
          return json(res, 200, created);
        }
        const keyIdMatch = path.match(/^\/api\/keys\/(\d+)$/);
        if (keyIdMatch && req.method === "DELETE") {
          db.revokeKey(Number(keyIdMatch[1]));
          return json(res, 200, { ok: true });
        }
      }

      return json(res, 404, errBody("Not found", "not_found"));
    } catch (e) {
      if (!res.headersSent && !res.destroyed) return json(res, 500, errBody(`Internal error: ${(e as Error).message}`, "internal_error"));
      res.destroy();
    }
  });
}
