export type ApiType = "openai-completions" | "openai-responses" | "anthropic-messages";
export const API_TYPES: readonly ApiType[] = ["openai-completions", "openai-responses", "anthropic-messages"];

/** Normalized usage: `input` always EXCLUDES cached tokens (no double counting). */
export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

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

/**
 * Incremental SSE usage parser. Feed arbitrary text chunks (may split mid-line);
 * call result() when the stream ends.
 */
export class StreamUsageCollector {
  #buffer = "";
  #usage: NormalizedUsage | null = null;

  constructor(private api: ApiType) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    let i: number;
    while ((i = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, i).trim();
      this.#buffer = this.#buffer.slice(i + 1);
      if (line) this.#line(line);
    }
  }

  #line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let ev: any;
    try { ev = JSON.parse(data); } catch { return; }

    if (this.api === "anthropic-messages") {
      if (ev.type === "message_start" && ev.message?.usage) {
        this.#usage = anthropicUsage(ev.message.usage) ?? this.#usage;
      } else if (ev.type === "message_delta" && ev.usage && this.#usage) {
        // message_delta carries cumulative output (and sometimes full usage)
        const d = anthropicUsage(ev.usage);
        if (d) this.#usage = { ...this.#usage, output: d.output, ...(ev.usage.input_tokens !== undefined ? { input: d.input, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite } : {}) };
      }
      return;
    }
    if (this.api === "openai-responses") {
      if ((ev.type === "response.completed" || ev.type === "response.incomplete") && ev.response?.usage) {
        this.#usage = openAiUsage(ev.response.usage) ?? this.#usage;
      }
      return;
    }
    // openai-completions: usage arrives on a (usually final) chunk
    if (ev.usage) this.#usage = openAiUsage(ev.usage) ?? this.#usage;
  }

  result(): NormalizedUsage | null {
    if (this.#buffer.trim()) { this.#line(this.#buffer.trim()); this.#buffer = ""; }
    return this.#usage;
  }
}
