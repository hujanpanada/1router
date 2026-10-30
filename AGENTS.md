# AGENTS.md — working on 1Router

Guidance for AI coding agents (and humans) contributing to this repo.

## What this is

1Router is a minimal, self-hosted, same-protocol LLM proxy whose single
job is **counting token usage** (input, output, cache read/write) and
requests — by client API key, provider, and model, over daily / weekly /
monthly / yearly / all-time windows. Everything is configured from a
vanilla web dashboard; all state lives in one SQLite database.

Deliberate non-goals — do not add these without an explicit request:
cost estimation/pricing, cross-protocol translation, fallback/round-robin
routing, OAuth/subscription logins, provider catalog sync (e.g. pi.dev),
frameworks or build tooling for the frontend.

## Ground rules

1. **Always TDD.** Write or update tests first, run them and watch them
   fail (red), then implement until green. Never skip the red step.
   Run `npm test` before every commit; `rm -rf dist` first if you suspect
   stale compiled output (tsc does not delete removed files).
2. **Minimal, zero runtime dependencies.** Runtime uses only Node built-ins
   (`node:http`, `node:sqlite`, `node:crypto`, global `fetch`). Dev deps are
   only `typescript` + `@types/node`. Do not add runtime packages.
3. **Frontend is vanilla HTML/CSS/JS only** (`public/`). No React/Vue,
   no bundler, no CSS framework.
4. **Never log or expose secrets.** Provider API keys are stored in SQLite
   (they must be retrievable) but must never be returned by any API after
   saving — only the masked form (`••••last4`). Client API keys and the
   dashboard password are stored hashed only. The dashboard session cookie
   must never be forwarded to upstream providers.
5. **The proxy must stay transparent and non-breaking.** Forward request/
   response bodies intact; counting happens by observing a copy. A failure
   in usage recording must never fail the request. Strip `content-encoding`
   and `set-cookie` from upstream responses (fetch already decompressed the
   body; forwarding them breaks browser clients), and strip client
   `authorization` / `x-api-key` / `cookie` headers before forwarding.

## Architecture

| File | Responsibility |
|---|---|
| `src/usage.ts` | Per-API usage extraction + incremental SSE parsing. Normalized `input` always **excludes** cached tokens (no double counting: OpenAI's `cached_tokens` is subtracted; Anthropic separates it natively). |
| `src/reasoning.ts` | Reasoning-level validation and manual per-model capability resolution. 1Router deliberately does **no** provider/model profile matching. |
| `src/auth.ts` | Scrypt password hashing, dashboard session helpers, default-password seeding. Default dashboard password is `1router` (seeded hashed, user prompted to change). Never store plaintext. |
| `src/db.ts` | All SQLite access (`node:sqlite`): settings, sessions, providers, provider_models, client_keys, usage_events, stats aggregation. Usage history migrates in place (schema changes must not drop token counts). |
| `src/server.ts` | HTTP server: proxy endpoints, dashboard session auth, admin API (`/api/*`), server-side `/api/test-request`, static file serving. |
| `src/main.ts` | Entrypoint: env config (`PORT`, `HOST`, `DB_PATH`), DB creation, listen. |
| `src/cli.ts` | Optional terminal key management (`key:create/list/revoke`). |
| `public/login.html` | Standalone login page (inline CSS/JS). |
| `public/index.html` / `app.js` / `style.css` | Dashboard SPA (tabs: Dashboard, Providers, API Keys, How to Use, Settings). Auth via HttpOnly session cookie; it must never call `/v1/*` directly from the browser — use `/api/test-request` for tests. |
| `images/` | README/docs screenshots only (e.g. dashboard screenshot embedded in `README.md`). Not application code, not served by the server. |

Supported API types (exactly these three): `openai-completions`
(`POST /v1/chat/completions`), `openai-responses` (`POST /v1/responses`),
`anthropic-messages` (`POST /v1/messages`). Routing is by
`model: "<provider-slug>/<modelId>"`, split on the **first** `/`.

Key semantics:
- Dashboard login (password) and client API keys (`sk-1r-…`) are separate
  credential systems; neither can substitute for the other.
- Stats: periods bucket in **server-local time**, weeks start **Monday**
  (SQLite `weekday 0, -6 days`). Weekly rows display as a Monday–Sunday
  (or Monday–Today) `YYYY-MM-DD` range — that formatting is UI-only in `app.js`.
- Streaming completions: the proxy injects `stream_options.include_usage`
  so the final chunk carries usage.
- Multimodal: image input is **blocked unless a model is explicitly
  marked image-capable** — unknown means blocked. Thinking is likewise
  opt-in: anything except explicit `thinking=true` strips reasoning fields
  and records effort `none`. Levels/defaults are manual; users can probe a
  level via `/api/test-request`.
- Proxy robustness: client disconnects abort the upstream request.
  Request/response size caps are enforced (413 for inbound, observation
  caps where service guarantees matter, e.g. `fetch-models`). SSE parsing
  tolerates multi-line `data:` payloads, string token counts, and drops
  oversized garbage instead of buffering forever.
- Backup: `/api/export` mirrors the DB and strips sessions from the copy only.
  Live sessions must survive export; password changes revoke all sessions.
- Schema: WAL + busy_timeout + foreign keys, schema versioned via
  `PRAGMA user_version`; provider writes are transactional.

## Commands

```bash
npm install
npm test          # build (tsc) + node:test suite
npm start         # build + serve on http://127.0.0.1:8787
npm run key:create -- <name>   # optional CLI alternative to the UI
```

## Testing conventions

- Tests live in `test/` (Node's built-in runner, compiled to `dist/test/`).
  UI contracts for `public/` go in `test/ui.test.ts` (static assertions on
  the served HTML/CSS/JS).
- Proxy behavior is tested end-to-end in `test/server.test.ts` against a
  mock upstream HTTP server — extend that mock rather than mocking `fetch`.
- New user-facing strings should be plain-language and actionable (say
  what to do, not just what failed). Assume users won't read raw errors.

## Commits

- Small, focused commits with imperative subjects (e.g. `feat: …`,
  `fix: …`, `docs: …`).
- **Every commit message must end with the co-author trailer:**

  ```
  Co-Authored-By: Muse Wonder
  ```
