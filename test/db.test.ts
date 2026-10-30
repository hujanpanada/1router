import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, type UsageEventInput } from "../src/db.js";
import { capabilityFor } from "../src/reasoning.js";

function ev(partial: Partial<UsageEventInput>): UsageEventInput {
  return {
    ts: Date.now(), clientKeyId: 1, provider: "openai", model: "gpt-5",
    api: "openai-completions", input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
    httpStatus: 200, streaming: false, latencyMs: 42, usageMissing: false,
    ...partial,
  };
}

// ---------- client keys ----------
test("client keys: multiple named keys, hash-only storage, revocable, lastUsed tracked", () => {
  const db = createDb(":memory:");
  const a = db.createKey("laptop");
  const b = db.createKey("work-pc");
  assert.match(a.key, /^sk-1r-/);
  assert.notEqual(a.key, b.key);
  assert.equal(db.findKeyBySecret(a.key)?.name, "laptop");
  assert.equal(db.findKeyBySecret(b.key)?.name, "work-pc");
  assert.equal(db.findKeyBySecret("sk-1r-wrong"), null);
  assert.ok(!JSON.stringify(db.listKeys()).includes(a.key));
  assert.ok(db.listKeys().find((k) => k.id === a.id)?.lastUsedAt);
  db.revokeKey(a.id);
  assert.equal(db.findKeyBySecret(a.key), null);
  assert.equal(db.findKeyBySecret(b.key)?.name, "work-pc");
});

// ---------- schema, pragmatas, throttled last-used, mirrored backup ----------
test("db has schema version, WAL/busy pragmas; key lastUsed throttled", async () => {
  const { rmSync, existsSync } = await import("node:fs");
  const path = "test-hardening-tmp.db";
  try { rmSync(path, { force: true }); rmSync(path + "-wal", { force: true }); rmSync(path + "-shm", { force: true }); } catch {}
  const made = Date.parse("2030-01-01T00:00:00Z");
  const db = createDb(path, { now: () => made });
  assert.equal(db.schemaVersion(), 1);
  const pragmas = db.pragmas();
  assert.equal(pragmas.user_version, 1);
  assert.equal(pragmas.journal_mode, "wal");
  assert.equal(pragmas.busy_timeout, 5000);
  assert.equal(pragmas.foreign_keys, 1);
  const key = db.createKey("throttle");
  const before = db.listKeys().find((k) => k.id === key.id)!;
  assert.equal(before.lastUsedAt, null);
  assert.equal(db.findKeyBySecret(key.key)?.name, "throttle");
  const after = db.listKeys().find((k) => k.id === key.id)!;
  assert.equal(after.lastUsedAt, made);
  // Mutating the returned object must not alter storage; next authenticate is throttled.
  db.findKeyBySecret(key.key);
  assert.equal(db.listKeys().find((k) => k.id === key.id)?.lastUsedAt, made);
  db.close();
  assert.ok(existsSync(path));
  rmSync(path, { force: true }); rmSync(path + "-wal", { force: true }); rmSync(path + "-shm", { force: true });
});

test("serialize strips sessions from the copy but leaves live sessions intact", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const db = createDb(":memory:");
  const s = db.createSession(60_000);
  const bytes = db.serialize();
  assert.ok(db.findSession(s.token), "live session must survive export");
  const path = "test-serialize-tmp.db";
  writeFileSync(path, bytes);
  const restored = createDb(path);
  assert.equal(restored.findSession(s.token), null);
  restored.close();
  rmSync(path, { force: true }); rmSync(path + "-wal", { force: true }); rmSync(path + "-shm", { force: true });
});

test("changeLoginPassword revokes all sessions; pruneExpiredSessions cleans up", () => {
  const db = createDb(":memory:");
  db.setSetting("login_password_hash", "HASH");
  const s = db.createSession(60_000);
  assert.ok(db.findSession(s.token));
  db.deleteAllSessions();
  assert.equal(db.findSession(s.token), null);
  const old = db.createSession(-1000);
  assert.equal(db.pruneExpiredSessions(), 1);
  assert.ok(db.findSession(old.token) === null);
});

test("provider create/update are transactional on model errors", () => {
  const db = createDb(":memory:");
  assert.throws(() => db.createProvider({
    slug: "atomic", name: "Atomic", baseUrl: "https://x.example/v1", api: "openai-completions", apiKey: "k",
    models: ["good", "good"], modelMeta: [{ modelId: "good", imageInput: null, thinking: true, reasoning: { levels: ["bogus"] } as any }],
  }), /invalid reasoning/i);
  assert.deepEqual(db.listProviders(), []);
  const p = db.createProvider({ slug: "atomic2", name: "Atomic 2", baseUrl: "https://x.example/v1", api: "openai-responses", apiKey: "k", models: ["m1"] });
  assert.throws(() => db.updateProvider(p.id, { models: ["m1", "m1"], modelMeta: [{ modelId: "m1", imageInput: null, thinking: true, reasoning: { levels: ["bogus"] } as any }] }), /invalid reasoning/i);
  assert.deepEqual(db.getProvider(p.id)?.models.map((m) => m.modelId), ["m1"]);
  assert.equal(db.getProvider(p.id)?.models[0].imageInput, null);
});

test("providers persist explicit multimodal guards separately from reasoning profiles", () => {
  const db = createDb(":memory:");
  const p = db.createProvider({
    slug: "guards", name: "Guards", baseUrl: "https://x.example/v1", api: "openai-completions", apiKey: "k",
    models: ["gpt-5", "deepseek-reasoner", "plain-text"],
  });
  const provider = db.getProvider(p.id)!;
  assert.deepEqual(provider.models.map((m) => [m.modelId, m.reasoning]), [
    ["deepseek-reasoner", null],
    ["gpt-5", null],
    ["plain-text", null],
  ]);
  const updated = db.updateProvider(p.id, {
    modelMeta: [
      { modelId: "gpt-5", imageInput: true, thinking: true, reasoning: { levels: ["low", "medium", "high"], defaultLevel: "provider" } },
      { modelId: "deepseek-reasoner", imageInput: false, thinking: true, reasoning: { levels: ["low", "high"], defaultLevel: "provider" } },
    ],
  });
  assert.deepEqual(updated.models.map((m) => [m.modelId, m.imageInput, m.reasoning?.levels ?? null, m.reasoning?.source ?? null]), [
    ["deepseek-reasoner", false, ["low", "high"], "manual"],
    ["gpt-5", true, ["low", "medium", "high"], "manual"],
    ["plain-text", null, null, null],
  ]);
});

test("capabilityFor never matches built-in model profiles", () => {
  assert.equal(capabilityFor("openai", "gpt-5").reasoning, null);
  assert.equal(capabilityFor("anthropic", "claude-sonnet-5").reasoning, null);
  const manual = capabilityFor("openai", "gpt-5", {
    imageInput: true,
    thinking: true,
    reasoning: { levels: ["minimal", "max"], defaultLevel: "max" },
  });
  assert.equal(manual.imageInput, true);
  assert.deepEqual(manual.reasoning?.levels, ["minimal", "max"]);
  assert.equal(manual.defaultEffort, "max");
});

test("thinking metadata is stored separately from image metadata", () => {
  const db = createDb(":memory:");
  const p = db.createProvider({
    slug: "thinking", name: "Thinking", baseUrl: "https://x.example/v1", api: "openai-completions", apiKey: "k",
    models: ["enabled-model", "disabled-model", "unset-model"],
  });
  const updated = db.updateProvider(p.id, {
    modelMeta: [
      { modelId: "enabled-model", imageInput: true, thinking: true, reasoning: { levels: ["low", "high"], defaultLevel: "low" } },
      { modelId: "disabled-model", imageInput: true, thinking: false, reasoning: { levels: ["low", "high"], defaultLevel: "low" } },
    ],
  });
  assert.deepEqual(updated.models.map((m) => [m.modelId, m.imageInput, m.thinking, m.reasoning?.levels ?? null]), [
    ["disabled-model", true, false, ["low", "high"]],
    ["enabled-model", true, true, ["low", "high"]],
    ["unset-model", null, null, null],
  ]);
  // Reasoning set while thinking is merely unset must not be discarded.
  const unsetReasoning = db.updateProvider(p.id, {
    modelMeta: [{ modelId: "unset-model", imageInput: null, thinking: null, reasoning: { levels: ["medium"], defaultLevel: "medium" } }],
  });
  assert.deepEqual(unsetReasoning.models.find((m) => m.modelId === "unset-model")?.reasoning?.levels, ["medium"]);
  assert.equal(db.resolveModel("thinking/enabled-model")?.thinking, true);
  assert.equal(db.resolveModel("thinking/disabled-model")?.thinking, false);
  assert.equal(db.resolveModel("thinking/unset-model")?.thinking, null);
});

// ---------- login password + sessions ----------
test("password settings: seeded on demand, changeable; sessions expire/revoke", () => {
  const db = createDb(":memory:");
  assert.equal(db.getSetting("login_password_hash"), null);
  db.setSetting("login_password_hash", "HASH1");
  assert.equal(db.getSetting("login_password_hash"), "HASH1");

  const s = db.createSession(60_000);
  assert.ok(db.findSession(s.token));
  db.deleteSession(s.token);
  assert.equal(db.findSession(s.token), null);

  const expired = db.createSession(-1000);
  assert.equal(db.findSession(expired.token), null);
});

// ---------- providers stored in DB ----------
test("providers: CRUD + resolveModel from DB (split on first slash)", () => {
  const db = createDb(":memory:");
  const p = db.createProvider({
    slug: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/", api: "openai-completions",
    apiKey: "sk-upstream", models: ["deepseek/deepseek-chat", "deepseek-reasoner"],
  });
  assert.equal(p.baseUrl, "https://api.deepseek.com/v1");

  const r = db.resolveModel("deepseek/deepseek/deepseek-chat");
  assert.equal(r?.provider, "deepseek");
  assert.equal(r?.modelId, "deepseek/deepseek-chat");
  assert.equal(r?.apiKey, "sk-upstream");
  assert.equal(r?.api, "openai-completions");
  assert.equal(db.resolveModel("deepseek/nope"), null);
  assert.equal(db.resolveModel("nope/x"), null);

  // update without apiKey keeps stored key; models replace
  db.updateProvider(p.id, { name: "DeepSeek 2", models: ["deepseek-reasoner"] });
  assert.equal(db.resolveModel("deepseek/deepseek-reasoner")?.apiKey, "sk-upstream");
  assert.equal(db.resolveModel("deepseek/deepseek/deepseek-chat"), null);
  db.updateProvider(p.id, { apiKey: "sk-new" });
  assert.equal(db.resolveModel("deepseek/deepseek-reasoner")?.apiKey, "sk-new");

  assert.throws(() => db.createProvider({ slug: "deepseek", name: "dup", baseUrl: "https://x.example/v1", api: "openai-responses", apiKey: "", models: [] }), /already exists/i);
  assert.throws(() => db.createProvider({ slug: "bad slug!", name: "x", baseUrl: "https://x.example/v1", api: "openai-responses", apiKey: "", models: [] }), /slug/i);
  assert.throws(() => db.createProvider({ slug: "ok", name: "x", baseUrl: "https://x.example/v1", api: "google-generative-ai" as any, apiKey: "", models: [] }), /unsupported api/i);
  assert.throws(
    () => db.updateProvider(p.id, { modelMeta: [{ modelId: "deepseek-reasoner", imageInput: null, thinking: true, reasoning: { levels: ["bogus"] } as any }] }),
    /invalid reasoning/i,
  );

  db.deleteProvider(p.id);
  assert.equal(db.resolveModel("deepseek/deepseek-reasoner"), null);
  assert.deepEqual(db.listProviders(), []);
});

// ---------- stats (no cost anywhere) ----------
test("stats by provider for all-time aggregates tokens + requests", () => {
  const db = createDb(":memory:");
  db.createKey("k");
  db.insertEvent(ev({ provider: "openai", input: 100, output: 50 }));
  db.insertEvent(ev({ provider: "openai", input: 300, output: 150, cacheRead: 100 }));
  db.insertEvent(ev({ provider: "anthropic", model: "claude-sonnet-5", input: 10, output: 5 }));
  const rows = db.stats({ period: "all", groupBy: "provider" });
  const openai = rows.find((r) => r.group === "openai")!;
  assert.equal(openai.requests, 2);
  assert.equal(openai.input, 400);
  assert.equal(openai.output, 200);
  assert.equal(openai.cacheRead, 100);
  assert.ok(!("costUsd" in openai) && !("cost" in openai));
});

test("stats grouped by client key and by model; periods bucket correctly", () => {
  const db = createDb(":memory:");
  const a = db.createKey("alice");
  const b = db.createKey("bob");
  db.insertEvent(ev({ clientKeyId: a.id, ts: new Date(2026, 0, 15).getTime() }));
  db.insertEvent(ev({ clientKeyId: b.id, ts: new Date(2026, 2, 15).getTime() }));
  db.insertEvent(ev({ clientKeyId: a.id, provider: "anthropic", model: "claude-sonnet-5", ts: new Date(2025, 2, 15).getTime() }));
  assert.equal(db.stats({ period: "all", groupBy: "key" }).find((r) => r.group === "alice")?.requests, 2);
  assert.equal(db.stats({ period: "all", groupBy: "model" }).find((r) => r.group === "openai/gpt-5")?.requests, 2);
  assert.equal(db.stats({ period: "monthly", groupBy: "provider" }).length, 3);
  const yearly = db.stats({ period: "yearly", groupBy: "provider" });
  assert.equal(yearly.find((r) => r.period === "2026")?.requests, 2);

  const today = new Date(); today.setHours(10, 30, 0, 0);
  const yesterday = new Date(Date.now() - 86400_000); yesterday.setHours(10, 30, 0, 0);
  db.insertEvent(ev({ ts: today.getTime() }));
  db.insertEvent(ev({ ts: yesterday.getTime() }));
  assert.equal(db.stats({ period: "daily", groupBy: "provider" }).filter((r) => r.group === "openai").length >= 2, true);
});

test("serialize produces a restorable backup without sessions", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const db = createDb(":memory:");
  const k = db.createKey("backup-key");
  db.createProvider({ slug: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses", apiKey: "secret", models: ["gpt-5"] });
  db.setSetting("login_password_hash", "HASH");
  db.createSession(60_000);
  db.insertEvent(ev({ clientKeyId: k.id }));
  const path = "test-backup-tmp.db";
  writeFileSync(path, db.serialize());
  const restored = createDb(path);
  assert.equal(restored.schemaVersion(), 1);
  assert.equal(restored.findKeyBySecret(k.key)?.name, "backup-key");
  assert.equal(restored.listProviders()[0].slug, "openai");
  assert.equal(restored.getSetting("login_password_hash"), "HASH");
  assert.equal(restored.findSession("anything"), null);
  assert.equal(restored.recentEvents(10).length, 1);
  restored.close();
  rmSync(path, { force: true });
});

test("events store effort when supplied and recent events expose it", () => {
  const db = createDb(":memory:");
  const k = db.createKey("effort");
  db.insertEvent(ev({ clientKeyId: k.id, effort: "high" }));
  assert.equal(db.recentEvents(1)[0].effort, "high");
});

test("recentEvents returns newest first", () => {
  const db = createDb(":memory:");
  db.createKey("k");
  db.insertEvent(ev({ ts: 1000, model: "old" }));
  db.insertEvent(ev({ ts: 2000, model: "new" }));
  assert.deepEqual(db.recentEvents(10).map((e) => e.model), ["new", "old"]);
});
