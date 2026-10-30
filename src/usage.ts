export type ApiType = "openai-completions" | "openai-responses" | "anthropic-messages";
export const API_TYPES: readonly ApiType[] = ["openai-completions", "openai-responses", "anthropic-messages"];

/** Normalized usage: `input` always EXCLUDES cached tokens (no double counting). */
export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const n = (v: unknown): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
};

function openAiUsage(raw: any): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const prompt = raw.prompt_tokens ?? raw.input_tokens;
  if (prompt === undefined && raw.output_tokens === undefined && raw.completion_tokens === undefined) return null;
  const details = raw.prompt_tokens_details ?? raw.input_tokens_details ?? {};
  const cacheRead = n(details.cached_tokens);
  const cacheWrite = n(details.cache_write_tokens ?? details.cache_creation_tokens);
  return {
    input: Math.max(0, n(prompt) - cacheRead - cacheWrite),
    output: n(raw.completion_tokens ?? raw.output_tokens),
    cacheRead,
    cacheWrite,
  };
}

function anthropicUsage(raw: any): NormalizedUsage | null {
  if (!raw || typeof raw !== "object" || (raw.input_tokens === undefined && raw.output_tokens === undefined)) return null;
  return {
    // Anthropic's input_tokens already excludes cache tokens.
    input: n(raw.input_tokens),
    output: n(raw.output_tokens),
    cacheRead: n(raw.cache_read_input_tokens),
    cacheWrite: n(raw.cache_creation_input_tokens),
  };
}

const normalize = (api: ApiType, raw: any): NormalizedUsage | null =>
  api === "anthropic-messages" ? anthropicUsage(raw) : openAiUsage(raw);

/** Extract usage from a non-streaming JSON response body. */
export function extractUsage(api: ApiType, body: any): NormalizedUsage | null {
  if (!body || typeof body !== "object") return null;
  // openai-responses puts usage at top level too; anthropic as well.
  return normalize(api, body.usage);
}

/** Extract balanced top-level JSON objects from a text blob (for split SSE data lines). */
function extractJsonObjects(text: string): any[] {
  const out: any[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* partial */ }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/**
 * Incremental SSE usage parser. Feed arbitrary text chunks (may split mid-line
 * or mid-event); call result() when the stream ends.
 *
 * Data payloads may span multiple `data:` lines; we join them and, if that
 * still isn't valid JSON, scan for balanced JSON objects in the event.
 * Oversized payloads are dropped rather than buffered forever.
 */
export class StreamUsageCollector {
  #buffer = "";
  #usage: NormalizedUsage | null = null;
  readonly #MAX_EVENT = 65_536;

  constructor(private api: ApiType) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    const parts = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = parts.pop() ?? "";
    for (const part of parts) this.#scanEventsData(part);
    if (this.#buffer.length > this.#MAX_EVENT * 4) this.#buffer = this.#buffer.slice(-this.#MAX_EVENT);
  }

  #scanEventsData(text: string): void {
    const datas: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("data:")) datas.push(line.slice(5));
    }
    const candidates: string[] = [];
    if (datas.length) candidates.push(datas.join("\n"), datas.join(""));
    candidates.push(text);
    for (const candidate of candidates) {
      if (this.#tryData(candidate)) return;
    }
    for (const obj of extractJsonObjects(text)) if (this.#accept(obj)) return;
  }

  #tryData(data: string): boolean {
    const d = data.trim();
    if (!d || d === "[DONE]") return false;
    if (d.length > this.#MAX_EVENT) return true; // consumed deliberately: oversized garbage
    let ev: any;
    try { ev = JSON.parse(d); } catch { return false; }
    return this.#accept(ev);
  }

  #accept(ev: any): boolean {
    if (!ev || typeof ev !== "object") return false;
    if (this.api === "anthropic-messages") {
      if (ev.type === "message_start" && ev.message?.usage) {
        this.#usage = anthropicUsage(ev.message.usage) ?? this.#usage;
        return true;
      }
      if (ev.type === "message_delta" && ev.usage) {
        const d = anthropicUsage(ev.usage);
        if (d) {
          const base = this.#usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          this.#usage = ev.usage.input_tokens !== undefined ? d : { ...base, output: d.output };
          return true;
        }
      }
      return false;
    }
    if (this.api === "openai-responses") {
      if ((ev.type === "response.completed" || ev.type === "response.incomplete") && ev.response?.usage) {
        this.#usage = openAiUsage(ev.response.usage) ?? this.#usage;
        return true;
      }
      return false;
    }
    if (ev.usage) {
      this.#usage = openAiUsage(ev.usage) ?? this.#usage;
      return true;
    }
    return false;
  }

  result(): NormalizedUsage | null {
    if (this.#buffer.trim()) { this.#scanEventsData(this.#buffer); this.#buffer = ""; }
    return this.#usage;
  }
}
