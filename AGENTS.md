# AGENTS.md — working on 1Router

Guidance for AI coding agents and humans contributing to 1Router.

## Core principles

- **Git first:** Never commit directly to `main`. Create a new branch each time (`feature/*`, `fix/*`, `cleanup/*`).
- **Always TDD:** Write or update tests first, observe red, implement until green. Run `npm test` before every commit (`rm -rf dist` first if stale output is suspected).
- **Single source of truth:** Avoid fragmented state and duplicate mappings. Keep definitions where they belong.
- **Less jump-to-definition fatigue:** Avoid pass-through wrappers, unnecessary layers, and indirection. Write straightforward, pragmatic code.
- **Self-documenting code:** No stupid comments. Good code documents itself; keep comments only when explaining a non-obvious "why" or critical edge case.
- **Minimal, zero runtime dependencies:** Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`, global `fetch`). Dev deps only `typescript` + `@types/node`.
- **Vanilla frontend:** HTML/CSS/JS only (`public/`). No bundlers, frameworks, or CSS preprocessors.
- **Security & transparency:** Mask provider keys (`••••last4`), hash client keys and passwords. Transparent proxying: forward request/response intact, observe usage out-of-band without breaking requests.

## Architecture

| File | Responsibility |
|---|---|
| `src/usage.ts` | Usage extraction & SSE streaming parsing (excludes cached tokens from input). |
| `src/auth.ts` | Scrypt password hashing & dashboard session auth. |
| `src/db.ts` | SQLite storage (`node:sqlite`): settings, sessions, providers, keys, usage events, stats aggregation, model capabilities & reasoning validation. |
| `src/server.ts` | HTTP server: proxy routing, rate limiting, security headers, admin API (`/api/*`), static files. |
| `src/main.ts` | Entrypoint: configuration & server startup. |
| `src/cli.ts` | CLI key management (`key:create/list/revoke`). |
| `public/` | Vanilla dashboard SPA & login page. |

Supported API types: `openai-completions` (`POST /v1/chat/completions`), `openai-responses` (`POST /v1/responses`), `anthropic-messages` (`POST /v1/messages`). Model routing is `<provider-slug>/<modelId>` split on first `/`.

## Commands

```bash
npm install
npm test          # build (tsc) + test suite
npm start         # build + serve on http://127.0.0.1:8787
npm run key:create -- <name>
```

## Commits

- Small, focused commits with imperative subjects (`feat: …`, `fix: …`, `cleanup: …`, `refactor: …`).
- Every commit message must end with the co-author trailer:

  ```
  Co-Authored-By: <Model Name>
  ```
