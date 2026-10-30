# 1Router Plan (v2 — web-first)

Transparent proxy whose job is **counting token usage** (input, output, cache
read/write) and requests, by client API key / provider / model —
daily / weekly / monthly / yearly / all-time. No cost estimation.

## Decisions
- TypeScript, Node >= 22.19, zero runtime dependencies (`node:http`, `node:sqlite`).
- **No config files.** Providers, models, client keys, and the dashboard
  password all live in SQLite and are managed from the vanilla web UI.
- Only `api`: `openai-completions`, `openai-responses`, `anthropic-messages`.
  Same-protocol passthrough only (no translation/fallback/OAuth — non-goals).
- Routing: client sends `model: "<provider>/<modelId>"` (split on first `/`).
- Dashboard login: password only, stored as a scrypt hash in SQLite,
  default `1router` (banner prompts to change it). Sessions: hashed,
  HttpOnly cookie, 7 days. Dashboard password ≠ client API keys.
- Provider API keys must be stored retrievably (proxy has to send them);
  masked in UI, never returned by the API after save.
- Daily boundaries in server local time; weeks start Monday.
- Pre-v2 databases migrate in place: token history kept, `cost_usd` dropped.

## Pages (vanilla HTML/CSS/JS)
Dashboard (tokens/requests) · Providers (CRUD + fetch-models from upstream) ·
API Keys (multiple named keys, shown once) · How to Use (live base URL, curl,
Pi snippet, one-click test request, error decoder) · Settings (password).

## Remaining ideas (not built)
Per-key quotas/limits, cross-protocol translation, fallback routing,
provider-returned cost (e.g. OpenRouter `usage.cost`) as an optional column.
