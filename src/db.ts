import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { API_TYPES, type ApiType } from "./usage.js";

export interface UsageEventInput {
  ts: number;
  clientKeyId: number;
  provider: string;
  model: string;
  api: ApiType;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  httpStatus: number;
  streaming: boolean;
  latencyMs: number;
  usageMissing: boolean;
}

export interface UsageEvent extends Omit<UsageEventInput, "streaming" | "usageMissing"> {
  id: number;
  streaming: boolean;
  usageMissing: boolean;
}

export interface StatsRow {
  period: string;
  group: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StatsPeriod = "daily" | "weekly" | "monthly" | "yearly" | "all";
export type StatsGroupBy = "key" | "provider" | "model";

export interface ClientKey { id: number; name: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }

export interface ProviderInput {
  slug: string;
  name: string;
  baseUrl: string;
  api: ApiType;
  apiKey: string;
  models: string[];
}

export interface Provider extends ProviderInput { id: number; createdAt: number }

export interface ResolvedModel {
  provider: string;
  providerName: string;
  modelId: string;
  api: ApiType;
  baseUrl: string;
  apiKey: string;
}

export interface Db {
  // settings (login password hash lives here)
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  // dashboard sessions
  createSession(ttlMs: number): { token: string; expiresAt: number };
  findSession(token: string): { expiresAt: number } | null;
  deleteSession(token: string): void;
  // client keys (proxy auth)
  createKey(name: string): { id: number; name: string; key: string };
  findKeyBySecret(secret: string): ClientKey | null;
  listKeys(): ClientKey[];
  revokeKey(id: number): void;
  // upstream providers (managed from the web UI)
  createProvider(p: ProviderInput): Provider;
  updateProvider(id: number, patch: Partial<ProviderInput>): Provider;
  deleteProvider(id: number): void;
  listProviders(): Provider[];
  getProvider(id: number): Provider | null;
  resolveModel(fullId: string): ResolvedModel | null;
  listModels(): { id: string; provider: string; modelId: string; api: ApiType }[];
  // usage
  insertEvent(e: UsageEventInput): number;
  stats(q: { period: StatsPeriod; groupBy: StatsGroupBy }): StatsRow[];
  recentEvents(limit: number): UsageEvent[];
  close(): void;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

const PERIOD_EXPR: Record<StatsPeriod, string> = {
  // localtime: daily boundaries follow the server's local timezone. Weeks start Monday.
  daily: "date(ts/1000,'unixepoch','localtime')",
  weekly: "date(ts/1000,'unixepoch','localtime','weekday 0','-6 days')",
  monthly: "strftime('%Y-%m', ts/1000,'unixepoch','localtime')",
  yearly: "strftime('%Y', ts/1000,'unixepoch','localtime')",
  all: "'all'",
};

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function validateProvider(p: ProviderInput): ProviderInput {
  if (!SLUG_RE.test(p.slug)) throw new Error(`Invalid provider slug "${p.slug}" (letters, numbers, - and _ only)`);
  if (!(API_TYPES as readonly string[]).includes(p.api)) throw new Error(`Unsupported api "${String(p.api)}". Supported: ${API_TYPES.join(", ")}`);
  let url: URL;
  try { url = new URL(p.baseUrl); } catch { throw new Error(`Invalid baseUrl: ${p.baseUrl}`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("baseUrl must start with http:// or https://");
  const models = [...new Set((p.models ?? []).map((m) => m.trim()).filter(Boolean))];
  return { ...p, baseUrl: p.baseUrl.replace(/\/+$/, ""), name: p.name.trim() || p.slug, models };
}

export function createDb(path: string): Db {
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_keys (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      base_url TEXT NOT NULL, api TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_models (
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL, PRIMARY KEY (provider_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
      client_key_id INTEGER NOT NULL REFERENCES client_keys(id),
      provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      http_status INTEGER NOT NULL, streaming INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL, usage_missing INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_key_ts ON usage_events(client_key_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_provider_ts ON usage_events(provider, ts);
  `);
  // Migrate pre-v2 databases: cost tracking was removed; keep the token history.
  const cols = (sqlite.prepare("PRAGMA table_info(usage_events)").all() as any[]).map((c) => c.name);
  if (cols.includes("cost_usd")) sqlite.exec("ALTER TABLE usage_events DROP COLUMN cost_usd");
  const keyCols = (sqlite.prepare("PRAGMA table_info(client_keys)").all() as any[]).map((c) => c.name);
  if (keyCols.length && !keyCols.includes("last_used_at")) sqlite.exec("ALTER TABLE client_keys ADD COLUMN last_used_at INTEGER");

  const toKey = (r: any): ClientKey => ({
    id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null,
  });
  const toProvider = (r: any): Provider => ({
    id: r.id, slug: r.slug, name: r.name, baseUrl: r.base_url, api: r.api, apiKey: r.api_key,
    createdAt: r.created_at,
    models: (sqlite.prepare("SELECT model_id FROM provider_models WHERE provider_id = ? ORDER BY model_id").all(r.id) as any[]).map((m) => m.model_id),
  });
  const replaceModels = (providerId: number, models: string[]) => {
    sqlite.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(providerId);
    const ins = sqlite.prepare("INSERT INTO provider_models (provider_id, model_id) VALUES (?, ?)");
    for (const m of models) ins.run(providerId, m);
  };

  return {
    getSetting(key) {
      const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
      return r ? r.value : null;
    },
    setSetting(key, value) {
      sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },

    createSession(ttlMs) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + ttlMs;
      sqlite.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash(token), Date.now(), expiresAt);
      return { token, expiresAt };
    },
    findSession(token) {
      if (!token) return null;
      const r = sqlite.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash(token)) as any;
      if (!r || r.expires_at <= Date.now()) return null;
      return { expiresAt: r.expires_at };
    },
    deleteSession(token) {
      if (token) sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
    },

    createKey(name) {
      const key = "sk-1r-" + randomBytes(24).toString("base64url");
      const info = sqlite.prepare("INSERT INTO client_keys (name, key_hash, created_at) VALUES (?, ?, ?)").run(name, hash(key), Date.now());
      return { id: Number(info.lastInsertRowid), name, key };
    },
    findKeyBySecret(secret) {
      if (!secret) return null;
      const r = sqlite.prepare("SELECT * FROM client_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(secret)) as any;
      if (!r) return null;
      sqlite.prepare("UPDATE client_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), r.id);
      return toKey({ ...r, last_used_at: Date.now() });
    },
    listKeys() {
      return (sqlite.prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM client_keys ORDER BY id").all() as any[]).map(toKey);
    },
    revokeKey(id) {
      sqlite.prepare("UPDATE client_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
    },

    createProvider(input) {
      const p = validateProvider(input);
      if (sqlite.prepare("SELECT id FROM providers WHERE slug = ?").get(p.slug)) {
        throw new Error(`Provider slug "${p.slug}" already exists`);
      }
      const info = sqlite.prepare("INSERT INTO providers (slug, name, base_url, api, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(p.slug, p.name, p.baseUrl, p.api, p.apiKey ?? "", Date.now());
      const id = Number(info.lastInsertRowid);
      replaceModels(id, p.models);
      return this.getProvider(id)!;
    },
    updateProvider(id, patch) {
      const current = this.getProvider(id);
      if (!current) throw new Error(`Provider ${id} not found`);
      const merged = validateProvider({
        slug: patch.slug ?? current.slug, name: patch.name ?? current.name,
        baseUrl: patch.baseUrl ?? current.baseUrl, api: patch.api ?? current.api,
        // blank/omitted apiKey on edit = keep the stored one
        apiKey: patch.apiKey ? patch.apiKey : current.apiKey,
        models: patch.models ?? current.models,
      });
      const clash = sqlite.prepare("SELECT id FROM providers WHERE slug = ? AND id != ?").get(merged.slug, id);
      if (clash) throw new Error(`Provider slug "${merged.slug}" already exists`);
      sqlite.prepare("UPDATE providers SET slug = ?, name = ?, base_url = ?, api = ?, api_key = ? WHERE id = ?")
        .run(merged.slug, merged.name, merged.baseUrl, merged.api, merged.apiKey, id);
      if (patch.models) replaceModels(id, merged.models);
      return this.getProvider(id)!;
    },
    deleteProvider(id) {
      sqlite.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(id);
      sqlite.prepare("DELETE FROM providers WHERE id = ?").run(id);
    },
    listProviders() {
      return (sqlite.prepare("SELECT * FROM providers ORDER BY id").all() as any[]).map(toProvider);
    },
    getProvider(id) {
      const r = sqlite.prepare("SELECT * FROM providers WHERE id = ?").get(id) as any;
      return r ? toProvider(r) : null;
    },
    resolveModel(fullId) {
      const slash = fullId.indexOf("/");
      if (slash <= 0) return null;
      const slug = fullId.slice(0, slash);
      const modelId = fullId.slice(slash + 1);
      const r = sqlite.prepare("SELECT * FROM providers WHERE slug = ?").get(slug) as any;
      if (!r) return null;
      const exists = sqlite.prepare("SELECT 1 FROM provider_models WHERE provider_id = ? AND model_id = ?").get(r.id, modelId);
      if (!exists) return null;
      return { provider: r.slug, providerName: r.name, modelId, api: r.api, baseUrl: r.base_url, apiKey: r.api_key };
    },
    listModels() {
      const rows = sqlite.prepare(`
        SELECT p.slug, p.api, m.model_id FROM providers p
        JOIN provider_models m ON m.provider_id = p.id ORDER BY p.slug, m.model_id`).all() as any[];
      return rows.map((r) => ({ id: `${r.slug}/${r.model_id}`, provider: r.slug, modelId: r.model_id, api: r.api as ApiType }));
    },

    insertEvent(e) {
      const info = sqlite.prepare(`
        INSERT INTO usage_events (ts, client_key_id, provider, model, api, input, output, cache_read, cache_write,
                                  http_status, streaming, latency_ms, usage_missing)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.ts, e.clientKeyId, e.provider, e.model, e.api, e.input, e.output, e.cacheRead, e.cacheWrite,
             e.httpStatus, e.streaming ? 1 : 0, e.latencyMs, e.usageMissing ? 1 : 0);
      return Number(info.lastInsertRowid);
    },
    stats({ period, groupBy }) {
      const groupExpr = groupBy === "key" ? "k.name" : groupBy === "provider" ? "e.provider" : "e.provider || '/' || e.model";
      const rows = sqlite.prepare(`
        SELECT ${PERIOD_EXPR[period]} AS period, ${groupExpr} AS grp,
               COUNT(*) AS requests, COALESCE(SUM(e.input),0) AS input, COALESCE(SUM(e.output),0) AS output,
               COALESCE(SUM(e.cache_read),0) AS cache_read, COALESCE(SUM(e.cache_write),0) AS cache_write
        FROM usage_events e JOIN client_keys k ON k.id = e.client_key_id
        GROUP BY period, grp ORDER BY period DESC, requests DESC`).all() as any[];
      return rows.map((r) => ({
        period: r.period, group: r.grp, requests: r.requests, input: r.input, output: r.output,
        cacheRead: r.cache_read, cacheWrite: r.cache_write,
      }));
    },
    recentEvents(limit) {
      const rows = sqlite.prepare("SELECT * FROM usage_events ORDER BY id DESC LIMIT ?").all(limit) as any[];
      return rows.map((r) => ({
        id: r.id, ts: r.ts, clientKeyId: r.client_key_id, provider: r.provider, model: r.model, api: r.api,
        input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
        httpStatus: r.http_status, streaming: !!r.streaming, latencyMs: r.latency_ms, usageMissing: !!r.usage_missing,
      }));
    },
    close() { sqlite.close(); },
  };
}
