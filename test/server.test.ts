import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createDb } from "../src/db.js";
import { createServer } from "../src/server.js";

// --- mock upstream ---
let lastUpstream: { headers: http.IncomingHttpHeaders; body: any; url?: string; method?: string } = { headers: {}, body: null };
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = req.method === "POST" ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : null;
    lastUpstream = { headers: req.headers, body, url: req.url, method: req.method };
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "gpt-x" }, { id: "gpt-x-mini" }] }));
    }
    if (body?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url?.endsWith("/messages")) {
        res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":500,"output_tokens":1,"cache_read_input_tokens":800,"cache_creation_input_tokens":100}}}\n\n');
        res.write('data: {"type":"message_delta","usage":{"output_tokens":120}}\n\n');
      } else if (req.url?.endsWith("/responses")) {
        res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":300,"input_tokens_details":{"cached_tokens":250}}}}\n\n');
      } else {
        const payload = 'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":400}}}\n\n';
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' + payload.slice(0, 25));
        res.write(payload.slice(25) + "data: [DONE]\n\n");
      }
      return res.end();
    }
    if (req.url?.endsWith("/messages")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "msg_1", usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } }));
    }
    if (req.url?.endsWith("/responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "resp_1", usage: { input_tokens: 1000, output_tokens: 300, input_tokens_details: { cached_tokens: 250 } } }));
    }
    const payload = JSON.stringify({ id: "chatcmpl_1", usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } } });
    if (req.headers["x-force-gzip"]) {
      // real upstreams (esp. behind Cloudflare) gzip; undici decodes before the proxy sees it
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "set-cookie": "cf=abc; Path=/" });
      return res.end(gzipSync(payload));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
});

let base = "";
let db: ReturnType<typeof createDb>;
let app: http.Server;
let cookie = "";
let clientKey = "";

async function login(password: string) {
  const res = await fetch(base + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  return res;
}

before(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  db = createDb(":memory:");
  db.createProvider({ slug: "fakeopenai", name: "Fake OpenAI", baseUrl: up, api: "openai-completions", apiKey: "upstream-secret", models: ["gpt-x"] });
  db.createProvider({ slug: "fakeresp", name: "Fake Resp", baseUrl: up, api: "openai-responses", apiKey: "upstream-secret", models: ["gpt-r"] });
  db.createProvider({ slug: "fakeanthropic", name: "Fake Anthropic", baseUrl: up, api: "anthropic-messages", apiKey: "upstream-secret", models: ["claude-x"] });
  app = createServer({ db });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => upstream.close(r));
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${clientKey}`, ...headers },
    body: JSON.stringify(body),
  });
}
const admin = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

// ---------- login / session ----------
test("dashboard requires login; default password '1router' logs in and sets session cookie", async () => {
  const home = await fetch(base + "/", { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.match(home.headers.get("location") ?? "", /login/);
  assert.equal((await admin("/api/stats?period=all&groupBy=provider")).status, 401);

  assert.equal((await login("wrong")).status, 401);
  const ok = await login("1router");
  assert.equal(ok.status, 200);
  cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^1router_session=/);
  assert.equal((await fetch(base + "/", { headers: { cookie } })).status, 200);
  const me = (await (await admin("/api/me")).json()) as any;
  assert.equal(me.passwordIsDefault, true);
});

test("change password: old stops working, new works, default flag clears", async () => {
  const bad = await admin("/api/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "nope", newPassword: "newpass123" }) });
  assert.equal(bad.status, 400);
  const ok = await admin("/api/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "1router", newPassword: "newpass123" }) });
  assert.equal(ok.status, 200);
  assert.equal((await login("1router")).status, 401);
  assert.equal((await login("newpass123")).status, 200);
  const me = (await (await admin("/api/me")).json()) as any;
  assert.equal(me.passwordIsDefault, false);
  // restore for later tests using the existing cookie (session survives password change)
});

test("client keys cannot access admin APIs (login is separate)", async () => {
  const k = await admin("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "test-client" }) });
  assert.equal(k.status, 200);
  const created = (await k.json()) as any;
  assert.match(created.key, /^sk-1r-/);
  clientKey = created.key;
  const asClient = await fetch(base + "/api/stats?period=all&groupBy=provider", { headers: { authorization: `Bearer ${clientKey}` } });
  assert.equal(asClient.status, 401);
  // keys list shows names but never plaintext
  const list = (await (await admin("/api/keys")).json()) as any[];
  assert.ok(list.some((x) => x.name === "test-client"));
  assert.ok(!JSON.stringify(list).includes(clientKey));
});

// ---------- provider management ----------
test("providers CRUD via API: masked key, models stored, proxy picks up changes without restart", async () => {
  const created = await admin("/api/providers", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "added", name: "Added", baseUrl: lastUpstreamUrl(), api: "openai-completions", apiKey: "upstream-secret", models: ["gpt-x"] }),
  });
  assert.equal(created.status, 201);
  const list = (await (await admin("/api/providers")).json()) as any[];
  const added = list.find((p) => p.slug === "added");
  assert.ok(added);
  assert.ok(!JSON.stringify(list).includes("upstream-secret"), "upstream key must never be returned");
  assert.match(added.apiKeyMasked, /cret$/);

  const res = await post("/v1/chat/completions", { model: "added/gpt-x", messages: [] });
  assert.equal(res.status, 200);

  const del = await admin(`/api/providers/${added.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await post("/v1/chat/completions", { model: "added/gpt-x", messages: [] })).status, 400);
});

function lastUpstreamUrl() {
  // baseUrl of the seeded fake providers points at the mock upstream
  return db.listProviders()[0].baseUrl;
}

test("fetch-models proxies upstream /models with the given credentials", async () => {
  const res = await admin("/api/providers/fetch-models", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: lastUpstreamUrl(), api: "openai-completions", apiKey: "upstream-secret" }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as any;
  assert.deepEqual(json.models, ["gpt-x", "gpt-x-mini"]);
  assert.equal(lastUpstream.headers.authorization, "Bearer upstream-secret");
});

// ---------- proxy behaviour (providers now come from DB) ----------
test("rejects proxy requests without a valid client key; /v1/models lists DB providers", async () => {
  const res = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.equal((await fetch(base + "/health")).status, 200);
  const models = (await (await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${clientKey}` } })).json()) as any;
  assert.ok(models.data.map((m: any) => m.id).includes("fakeopenai/gpt-x"));
});

test("non-streaming completions: passthrough + auth swap + usage counted", async () => {
  const res = await post("/v1/chat/completions", { model: "fakeopenai/gpt-x", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).id, "chatcmpl_1");
  assert.equal(lastUpstream.headers.authorization, "Bearer upstream-secret");
  assert.equal(lastUpstream.body.model, "gpt-x");
  const [e] = db.recentEvents(1);
  assert.deepEqual({ provider: e.provider, model: e.model, input: e.input, output: e.output, cacheRead: e.cacheRead },
    { provider: "fakeopenai", model: "gpt-x", input: 600, output: 200, cacheRead: 400 });
});

test("streaming completions: intact body, include_usage injected, usage counted", async () => {
  const res = await post("/v1/chat/completions", { model: "fakeopenai/gpt-x", stream: true, messages: [] });
  const text = await res.text();
  assert.ok(text.includes('"delta":{"content":"hi"}') && text.includes("[DONE]"));
  assert.equal(lastUpstream.body.stream_options?.include_usage, true);
  const [e] = db.recentEvents(1);
  assert.equal(e.streaming, true);
  assert.deepEqual({ input: e.input, output: e.output, cacheRead: e.cacheRead }, { input: 600, output: 200, cacheRead: 400 });
});

test("anthropic-messages: x-api-key flow both sides, usage counted", async () => {
  const res = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": clientKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "fakeanthropic/claude-x", max_tokens: 100, messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(lastUpstream.headers["x-api-key"], "upstream-secret");
  assert.equal(lastUpstream.headers["anthropic-version"], "2023-06-01");
  const [e] = db.recentEvents(1);
  assert.deepEqual({ input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite },
    { input: 500, output: 120, cacheRead: 800, cacheWrite: 100 });
});

test("openai-responses non-streaming + streaming counted", async () => {
  await post("/v1/responses", { model: "fakeresp/gpt-r", input: "hi" });
  let [e] = db.recentEvents(1);
  assert.deepEqual({ input: e.input, output: e.output, cacheRead: e.cacheRead }, { input: 750, output: 300, cacheRead: 250 });
  const res = await post("/v1/responses", { model: "fakeresp/gpt-r", input: "hi", stream: true });
  assert.ok((await res.text()).includes("response.completed"));
  [e] = db.recentEvents(1);
  assert.deepEqual({ input: e.input, output: e.output }, { input: 750, output: 300 });
});

test("unknown model / wrong endpoint -> 400; admin stats works with session", async () => {
  assert.equal((await post("/v1/chat/completions", { model: "fakeopenai/nope", messages: [] })).status, 400);
  assert.equal((await post("/v1/chat/completions", { model: "fakeanthropic/claude-x", messages: [] })).status, 400);
  const rows = (await (await admin("/api/stats?period=all&groupBy=provider")).json()) as any[];
  assert.ok(rows.find((r) => r.group === "fakeopenai")?.requests >= 2);
});

test("gzipped upstream: proxy must not forward content-encoding/set-cookie for the decoded body", async () => {
  const res = await post("/v1/chat/completions", { model: "fakeopenai/gpt-x", messages: [] }, { "x-force-gzip": "1" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(((await res.json()) as any).id, "chatcmpl_1");
  const [e] = db.recentEvents(1);
  assert.equal(e.input, 600);
});

test("dashboard session cookie is never forwarded to the upstream provider", async () => {
  await post("/v1/chat/completions", { model: "fakeopenai/gpt-x", messages: [] }, { cookie: "1router_session=topsecret" });
  assert.equal(lastUpstream.headers.cookie, undefined);
});

test("POST /api/test-request runs a real counted request server-side and reports a friendly result", async () => {
  const before = db.recentEvents(1)[0]?.id ?? 0;
  const res = await admin("/api/test-request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fakeanthropic/claude-x", clientKey }),
  });
  assert.equal(res.status, 200);
  const r = (await res.json()) as any;
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok((db.recentEvents(1)[0]?.id ?? 0) > before, "test request should be counted like any other");
  assert.equal(db.recentEvents(1)[0].model, "claude-x");
});

test("POST /api/test-request with a bad key or model returns ok:false (not a raw HTTP error)", async () => {
  const badKey = (await (await admin("/api/test-request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fakeopenai/gpt-x", clientKey: "sk-1r-wrong" }),
  })).json()) as any;
  assert.equal(badKey.ok, false);
  assert.equal(badKey.status, 401);
  const badModel = (await (await admin("/api/test-request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fakeopenai/nope", clientKey }),
  })).json()) as any;
  assert.equal(badModel.ok, false);
  assert.equal(badModel.status, 400);
  // and it still requires a dashboard session
  assert.equal((await fetch(base + "/api/test-request", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});

test("logout invalidates the session", async () => {
  const res = await login("newpass123");
  const c = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await fetch(base + "/api/me", { headers: { cookie: c } })).status, 200);
  await fetch(base + "/api/logout", { method: "POST", headers: { cookie: c } });
  assert.equal((await fetch(base + "/api/me", { headers: { cookie: c } })).status, 401);
});
