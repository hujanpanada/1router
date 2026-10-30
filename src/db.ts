import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { API_TYPES, type ApiType } from "./usage.js";
import { validateReasoning, type ReasoningProfile } from "./reasoning.js";

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
  effort?: string | null;
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

export interface ModelMeta {
  modelId: string;
  /** true=images allowed through the proxy, false=blocked, null=unknown (blocked). */
  imageInput: boolean | null;
  /** true=thinking controls/request fields enabled, false=none, null=not set (treated as none). */
  thinking: boolean | null;
  reasoning: ReasoningProfile | null;
}

export interface ProviderInput {
  slug: string;
  name: string;
  baseUrl: string;
  api: ApiType;
  apiKey: string;
  models: string[];
  modelMeta?: ModelMeta[];
}

export interface Provider extends Omit<ProviderInput, "models" | "modelMeta"> {
  id: number;
  createdAt: number;
  models: ModelMeta[];
}

export interface ResolvedModel {
  provider: string;
  providerName: string;
  modelId: string;
  api: ApiType;
  baseUrl: string;
  apiKey: string;
  imageInput: boolean;
  thinking: boolean | null;
}

export interface DbPragmas { user_version: number; journal_mode: string; busy_timeout: number; foreign_keys: number }

export interface Db {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  createSession(ttlMs: number): { token: string; expiresAt: number };
  findSession(token: string): { expiresAt: number } | null;
  deleteSession(token: string): void;
  deleteAllSessions(): void;
  pruneExpiredSessions(): number;
  createKey(name: string): { id: number; name: string; key: string };
  findKeyBySecret(secret: string): ClientKey | null;
  listKeys(): ClientKey[];
  revokeKey(id: number): void;
  createProvider(p: ProviderInput): Provider;
  updateProvider(id: number, patch: Partial<ProviderInput>): Provider;
  deleteProvider(id: number): void;
  listProviders(): Provider[];
  getProvider(id: number): Provider | null;
  resolveModel(fullId: string): ResolvedModel | null;
  listModels(): { id: string; provider: string; modelId: string; api: ApiType }[];
  insertEvent(e: UsageEventInput): number;
  stats(q: { period: StatsPeriod; groupBy: StatsGroupBy }): StatsRow[];
  recentEvents(limit: number): UsageEvent[];
  serialize(): Uint8Array;
  schemaVersion(): number;
  pragmas(): DbPragmas;
  now?: () => number;
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
export const SCHEMA_VERSION = 1;
const LAST_USED_TOUCH_MS = 60_000;

function rowsToModelMeta(rows: any[]): ModelMeta[] {
  return rows.map((r) => {
    let reasoning: ModelMeta["reasoning"] = null;
    if (r.reasoning) {
      try { reasoning = validateReasoning(JSON.parse(r.reasoning), r.model_id); } catch { reasoning = null; }
    }
    if (reasoning) reasoning = { levels: reasoning.levels, defaultLevel: reasoning.defaultLevel ?? "provider", source: reasoning.source ?? "manual" };
    return {
      modelId: r.model_id,
      imageInput: r.image_input === null || r.image_input === undefined ? null : !!r.image_input,
      thinking: r.thinking === null || r.thinking === undefined ? null : !!r.thinking,
      reasoning: r.thinking === 0 ? null : reasoning,
    };
  });
}

function validateModels(models: string[] | undefined): string[] {
  if (!Array.isArray(models)) throw new Error("models must be an array");
  const out: string[] = [];
  for (const m of models) {
    if (typeof m !== "string" && (!m || typeof m !== "object" || typeof (m as any).id !== "string")) {
      throw new Error("Each model must be a string ID or an object with an id");
    }
    const id = (typeof m === "string" ? m : (m as any).id).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizeModelInputs(models: any[] | undefined): { models: string[]; modelMeta: ModelMeta[] } {
  const metas: ModelMeta[] = [];
  const ids = validateModels(models as any);
  for (const m of models ?? []) {
    if (m && typeof m === "object" && typeof m.id === "string") {
      metas.push({ modelId: m.id.trim(), imageInput: m.imageInput === true ? true : m.imageInput === false ? false : null,
        thinking: m.thinking === true ? true : m.thinking === false ? false : null,
        reasoning: m.thinking !== false && m.reasoning ? validateReasoning({ levels: m.reasoning.levels, defaultLevel: m.defaultEffort ?? m.reasoning.defaultLevel, source: "manual" }, m.id) : null });
    }
  }
  return { models: ids, modelMeta: metas };
}

function validateModelMeta(models: string[], meta: ModelMeta[] | undefined, providerLabel: string): Map<string, ModelMeta> {
  const out = new Map<string, ModelMeta>();
  const known = new Set(models);
  for (const m of meta ?? []) {
    if (!m || typeof m.modelId !== "string") continue;
    // meta rows for models that aren't enabled are ignored (not an error)
    const entry: ModelMeta = {
      modelId: m.modelId,
      imageInput: m.imageInput === true ? true : m.imageInput === false ? false : null,
      thinking: m.thinking === true ? true : m.thinking === false ? false : null,
      reasoning: m.thinking === false ? null : validateReasoning(m.reasoning as unknown, `${providerLabel}/${m.modelId}`),
    };
    if (known.has(m.modelId)) out.set(m.modelId, entry);
  }
  return out;
}

export function createDb(path: string, opts: { now?: () => number } = {}): Db {
  const now = opts.now ?? (() => Date.now());
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
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
      model_id TEXT NOT NULL,
      image_input INTEGER,
      thinking INTEGER,
      reasoning TEXT,
      PRIMARY KEY (provider_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
      client_key_id INTEGER NOT NULL REFERENCES client_keys(id),
      provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      http_status INTEGER NOT NULL, streaming INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL, usage_missing INTEGER NOT NULL,
      effort TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_key_ts ON usage_events(client_key_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_provider_ts ON usage_events(provider, ts);
  `);
  // In-place migrations (additive, never drop token history).
  const cols = (sqlite.prepare("PRAGMA table_info(usage_events)").all() as any[]).map((c) => c.name);
  if (cols.includes("cost_usd")) sqlite.exec("ALTER TABLE usage_events DROP COLUMN cost_usd");
  if (!cols.includes("effort")) sqlite.exec("ALTER TABLE usage_events ADD COLUMN effort TEXT");
  const keyCols = (sqlite.prepare("PRAGMA table_info(client_keys)").all() as any[]).map((c) => c.name);
  if (keyCols.length && !keyCols.includes("last_used_at")) sqlite.exec("ALTER TABLE client_keys ADD COLUMN last_used_at INTEGER");
  const modelCols = (sqlite.prepare("PRAGMA table_info(provider_models)").all() as any[]).map((c) => c.name);
  if (modelCols.length && !modelCols.includes("image_input")) sqlite.exec("ALTER TABLE provider_models ADD COLUMN image_input INTEGER");
  if (modelCols.length && !modelCols.includes("thinking")) sqlite.exec("ALTER TABLE provider_models ADD COLUMN thinking INTEGER");
  if (modelCols.length && !modelCols.includes("reasoning")) sqlite.exec("ALTER TABLE provider_models ADD COLUMN reasoning TEXT");

  // Stamp the schema version once. Existing v0 databases graduate to v1
  // only when all v1 columns exist, which the migrations above guarantee.
  const userVersion = Number((sqlite.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0);
  if (userVersion < SCHEMA_VERSION) sqlite.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);

  const toKey = (r: any): ClientKey => ({
    id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null,
  });
  const modelsOf = (pid: number): ModelMeta[] =>
    rowsToModelMeta(sqlite.prepare("SELECT model_id, image_input, thinking, reasoning FROM provider_models WHERE provider_id = ? ORDER BY model_id").all(pid) as any[]);
  const providerFromRow = (r: any): Provider => ({
    id: r.id, slug: r.slug, name: r.name, baseUrl: r.base_url, api: r.api, apiKey: r.api_key,
    createdAt: r.created_at, models: modelsOf(r.id),
  });
  const getProviderRowBySlug = (slug: string) => sqlite.prepare("SELECT * FROM providers WHERE slug = ?").get(slug) as any;
  const getProviderRowById = (id: number) => sqlite.prepare("SELECT * FROM providers WHERE id = ?").get(id) as any;


  const api: Db = {
    now,

    getSetting(key) {
      const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
      return r ? r.value : null;
    },
    setSetting(key, value) {
      sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    },

    createSession(ttlMs) {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      sqlite.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(hash(token), now(), expiresAt);
      return { token, expiresAt };
    },
    findSession(token) {
      if (!token) return null;
      const r = sqlite.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hash(token)) as any;
      if (!r || r.expires_at <= now()) return null;
      return { expiresAt: r.expires_at };
    },
    deleteSession(token) {
      if (token) sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
    },
    deleteAllSessions() {
      sqlite.exec("DELETE FROM sessions");
    },
    pruneExpiredSessions() {
      const info = sqlite.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
      return Number(info.changes);
    },

    createKey(name) {
      const key = "sk-1r-" + randomBytes(24).toString("base64url");
      const info = sqlite.prepare("INSERT INTO client_keys (name, key_hash, created_at) VALUES (?, ?, ?)").run(name, hash(key), now());
      return { id: Number(info.lastInsertRowid), name, key };
    },
    findKeyBySecret(secret) {
      if (!secret) return null;
      const r = sqlite.prepare("SELECT * FROM client_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(secret)) as any;
      if (!r) return null;
      const ts = now();
      // Throttle last-used writes: at most once per minute per key.
      if (r.last_used_at === null || ts - r.last_used_at >= LAST_USED_TOUCH_MS) {
        sqlite.prepare("UPDATE client_keys SET last_used_at = ? WHERE id = ?").run(ts, r.id);
        return toKey({ ...r, last_used_at: ts });
      }
      return toKey(r);
    },
    listKeys() {
      return (sqlite.prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM client_keys ORDER BY id").all() as any[]).map(toKey);
    },
    revokeKey(id) {
      sqlite.prepare("UPDATE client_keys SET revoked_at = ? WHERE id = ?").run(now(), id);
    },

    createProvider(input) {
      const slug = input.slug.trim();
      if (!SLUG_RE.test(slug)) throw new Error(`Invalid provider slug "${input.slug}" (letters, numbers, - and _ only)`);
      if (!(API_TYPES as readonly string[]).includes(input.api)) throw new Error(`Unsupported api "${String(input.api)}". Supported: ${API_TYPES.join(", ")}`);
      let url: URL;
      try { url = new URL(input.baseUrl); } catch { throw new Error(`Invalid baseUrl: ${input.baseUrl}`); }
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("baseUrl must start with http:// or https://");
      const normalized = normalizeModelInputs(input.models as any);
      const models = normalized.models;
      const meta = validateModelMeta(models, [...normalized.modelMeta, ...(input.modelMeta ?? [])], slug);
      sqlite.exec("BEGIN");
      try {
        if (getProviderRowBySlug(slug)) throw new Error(`Provider slug "${slug}" already exists`);
        const info = sqlite.prepare("INSERT INTO providers (slug, name, base_url, api, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(slug, input.name.trim() || slug, input.baseUrl.replace(/\/+$/, ""), input.api, input.apiKey ?? "", now());
        const id = Number(info.lastInsertRowid);
        const ins = sqlite.prepare("INSERT INTO provider_models (provider_id, model_id, image_input, thinking, reasoning) VALUES (?, ?, ?, ?, ?)");
        for (const mid of models) {
          const m = meta.get(mid);
          ins.run(id, mid, m?.imageInput == null ? null : m.imageInput ? 1 : 0, m?.thinking == null ? null : m.thinking ? 1 : 0, m?.thinking !== false && m?.reasoning ? JSON.stringify(m.reasoning) : null);
        }
        sqlite.exec("COMMIT");
        return api.getProvider(id)!;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
    updateProvider(id, patch) {
      const current = api.getProvider(id);
      if (!current) throw new Error(`Provider ${id} not found`);
      const slug = (patch.slug ?? current.slug).trim();
      if (!SLUG_RE.test(slug)) throw new Error(`Invalid provider slug "${slug}" (letters, numbers, - and _ only)`);
      const apiType = patch.api ?? current.api;
      if (!(API_TYPES as readonly string[]).includes(apiType)) throw new Error(`Unsupported api "${String(apiType)}". Supported: ${API_TYPES.join(", ")}`);
      const baseUrl = (patch.baseUrl ?? current.baseUrl).replace(/\/+$/, "");
      try { new URL(baseUrl); } catch { throw new Error(`Invalid baseUrl: ${baseUrl}`); }
      const normalizedPatch = patch.models ? normalizeModelInputs(patch.models as any) : null;
      const models = normalizedPatch?.models ?? current.models.map((m) => m.modelId);
      const existing = new Map(current.models.map((m) => [m.modelId, m]));
      const mergedMeta = new Map<string, ModelMeta>();
      for (const mid of models) {
        const prev = existing.get(mid);
        mergedMeta.set(mid, { modelId: mid, imageInput: prev?.imageInput ?? null, thinking: prev?.thinking ?? null, reasoning: prev?.thinking === false ? null : prev?.reasoning ?? null });
      }
      const objectMeta = normalizedPatch?.modelMeta ?? [];
      if (objectMeta.length || patch.modelMeta) {
        const meta = validateModelMeta(models, [...objectMeta, ...(patch.modelMeta ?? [])], slug);
        for (const [mid, m] of meta) mergedMeta.set(mid, m);
      }
      sqlite.exec("BEGIN");
      try {
        const clash = sqlite.prepare("SELECT id FROM providers WHERE slug = ? AND id != ?").get(slug, id);
        if (clash) throw new Error(`Provider slug "${slug}" already exists`);
        sqlite.prepare("UPDATE providers SET slug = ?, name = ?, base_url = ?, api = ?, api_key = ? WHERE id = ?")
          .run(slug, (patch.name ?? current.name).trim() || slug, baseUrl, apiType, patch.apiKey ? patch.apiKey : current.apiKey, id);
        sqlite.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(id);
        const ins = sqlite.prepare("INSERT INTO provider_models (provider_id, model_id, image_input, thinking, reasoning) VALUES (?, ?, ?, ?, ?)");
        for (const mid of models) {
          const m = mergedMeta.get(mid);
          ins.run(id, mid, m?.imageInput == null ? null : m.imageInput ? 1 : 0, m?.thinking == null ? null : m.thinking ? 1 : 0, m?.thinking !== false && m?.reasoning ? JSON.stringify(m.reasoning) : null);
        }
        sqlite.exec("COMMIT");
        return api.getProvider(id)!;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
    deleteProvider(id) {
      sqlite.exec("BEGIN");
      try {
        sqlite.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(id);
        sqlite.prepare("DELETE FROM providers WHERE id = ?").run(id);
        sqlite.exec("COMMIT");
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
    listProviders() {
      return (sqlite.prepare("SELECT * FROM providers ORDER BY id").all() as any[]).map(providerFromRow);
    },
    getProvider(id) {
      const r = getProviderRowById(id);
      return r ? providerFromRow(r) : null;
    },
    resolveModel(fullId) {
      const slash = fullId.indexOf("/");
      if (slash <= 0) return null;
      const slug = fullId.slice(0, slash);
      const modelId = fullId.slice(slash + 1);
      const r = getProviderRowBySlug(slug);
      if (!r) return null;
      const row = sqlite.prepare("SELECT image_input, thinking FROM provider_models WHERE provider_id = ? AND model_id = ?").get(r.id, modelId) as any;
      if (!row) return null;
      return { provider: r.slug, providerName: r.name, modelId, api: r.api, baseUrl: r.base_url, apiKey: r.api_key, imageInput: row.image_input === 1, thinking: row.thinking === null ? null : row.thinking === 1 };
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
                                  http_status, streaming, latency_ms, usage_missing, effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.ts, e.clientKeyId, e.provider, e.model, e.api, e.input, e.output, e.cacheRead, e.cacheWrite,
             e.httpStatus, e.streaming ? 1 : 0, e.latencyMs, e.usageMissing ? 1 : 0, e.effort ?? null);
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
    serialize() {
      // Snapshot the file, clear sessions in the snapshot only. We guard the
      // whole thing with a write transaction so a concurrent insert cannot
      // sneak in half-way; serialize() itself is already a consistent snapshot.
      const bytes = sqlite.serialize("main");
      try {
        const copy = new DatabaseSync(":memory:");
        copy.deserialize(bytes);
        copy.exec("DELETE FROM sessions");
        const out = copy.serialize("main");
        copy.close();
        return out;
      } catch {
        return bytes; // fallback: live DB untouched either way
      }
    },
    recentEvents(limit) {
      const rows = sqlite.prepare("SELECT * FROM usage_events ORDER BY id DESC LIMIT ?").all(limit) as any[];
      return rows.map((r) => ({
        id: r.id, ts: r.ts, clientKeyId: r.client_key_id, provider: r.provider, model: r.model, api: r.api,
        input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write,
        httpStatus: r.http_status, streaming: !!r.streaming, latencyMs: r.latency_ms, usageMissing: !!r.usage_missing,
        effort: r.effort ?? null,
      }));
    },
    schemaVersion() {
      return Number((sqlite.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0);
    },
    pragmas() {
      return {
        user_version: this.schemaVersion(),
        journal_mode: String((sqlite.prepare("PRAGMA journal_mode").get() as any)?.journal_mode ?? ""),
        busy_timeout: Number((sqlite.prepare("PRAGMA busy_timeout").get() as any)?.timeout ?? (sqlite.prepare("PRAGMA busy_timeout").get() as any)?.busy_timeout ?? 0),
        foreign_keys: Number((sqlite.prepare("PRAGMA foreign_keys").get() as any)?.foreign_keys ?? 0),
      };
    },
    close() { sqlite.close(); },
  };
  return api;
}
