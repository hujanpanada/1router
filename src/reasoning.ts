export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ReasoningProfile {
  levels: ThinkingLevel[]; // settable levels, "off" excluded; Pi adds it itself when supported
  defaultLevel: ThinkingLevel | "provider";
  source?: "manual" | "builtin";
}

export interface ModelCapability {
  modelId: string;
  /** Safe default is false: 1Router only forwards images when explicitly allowed. */
  imageInput: boolean;
  reasoning: ReasoningProfile | null;
  reasoningSource: "manual" | "builtin" | "none";
  defaultEffort: ThinkingLevel | "provider";
}

export function capabilityFor(providerSlug: string, modelId: string, stored?: { imageInput: boolean | null; reasoning: ReasoningProfile | null }): ModelCapability {
  const builtin = reasoningProfileFor(providerSlug, modelId);
  const reasoning = stored?.reasoning ?? builtin;
  return {
    modelId,
    imageInput: stored?.imageInput === true,
    reasoning: reasoning ? { levels: [...reasoning.levels], defaultLevel: reasoning.defaultLevel ?? "provider", source: reasoning.source ?? (stored?.reasoning ? "manual" : "builtin") } : null,
    reasoningSource: stored?.reasoning ? "manual" : builtin ? "builtin" : "none",
    defaultEffort: reasoning?.defaultLevel ?? "provider",
  };
}

/** Normalize/sanitize an unknown value into a ThinkingLevel, or null. */
export function asThinkingLevel(v: unknown): ThinkingLevel | null {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : null;
}

export function validateReasoning(raw: unknown, where: string): ReasoningProfile | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error(`Invalid reasoning profile for ${where}`);
  const levelsIn = (raw as any).levels;
  if (!Array.isArray(levelsIn)) throw new Error(`Invalid reasoning profile for ${where}: levels must be an array`);
  const levels: ThinkingLevel[] = [];
  for (const l of levelsIn) {
    const lvl = asThinkingLevel(l);
    if (!lvl || lvl === "off") throw new Error(`Invalid reasoning level "${String(l)}" for ${where} (use: minimal, low, medium, high, xhigh, max)`);
    if (!levels.includes(lvl)) levels.push(lvl);
  }
  const order: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  levels.sort((a, b) => order[a] - order[b]);
  const dflt = (raw as any).defaultLevel ?? "provider";
  if (dflt !== "provider" && !(typeof dflt === "string" && levels.includes(dflt as ThinkingLevel))) {
    throw new Error(`Invalid reasoning defaultLevel for ${where}: must be "provider" or one of its levels`);
  }
  return { levels, defaultLevel: dflt, source: (raw as any).source === "builtin" ? "builtin" : "manual" };
}

/**
 * Built-in reasoning profiles, curated conservatively. A profile applies only
 * to the exact provider slug + model ID listed. Levels are the *settable*
 * levels (other Pi levels, incl. "off", are unsupported unless a model maps
 * them in Pi's own catalog). Unknown model/provider: null — we never guess
 * from model names outside this list. Defaults are provider-side, so
 * defaultLevel is always "provider" here.
 */
type Entry = { provider: string; modelId: string; levels: ThinkingLevel[] };
const ENTRIES: Entry[] = [
  // OpenAI (slug "openai")
  { provider: "openai", modelId: "gpt-5", levels: ["minimal", "low", "medium", "high"] },
  { provider: "openai", modelId: "gpt-5-mini", levels: ["minimal", "low", "medium", "high"] },
  { provider: "openai", modelId: "gpt-5-nano", levels: ["minimal", "low", "medium", "high"] },
  { provider: "openai", modelId: "gpt-5-pro", levels: ["high"] },
  { provider: "openai", modelId: "gpt-5.1", levels: ["low", "medium", "high"] },
  { provider: "openai", modelId: "gpt-5.2", levels: ["low", "medium", "high", "xhigh"] },
  { provider: "openai", modelId: "gpt-5.2-pro", levels: ["medium", "high", "xhigh"] },
  // Anthropic (slug "anthropic") — Pi maps unlisted levels via the provider
  // request itself; only xhigh/max were declared non-default, so we surface
  // the full settable ladder these models accept via effort.
  { provider: "anthropic", modelId: "claude-sonnet-5", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "anthropic", modelId: "claude-sonnet-4-6", levels: ["low", "medium", "high", "max"] },
  { provider: "anthropic", modelId: "claude-opus-4-6", levels: ["low", "medium", "high", "max"] },
  { provider: "anthropic", modelId: "claude-opus-4-7", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "anthropic", modelId: "claude-opus-4-8", levels: ["low", "medium", "high", "xhigh", "max"] },
  // DeepSeek (slug "deepseek")
  { provider: "deepseek", modelId: "deepseek-flash", levels: ["low", "high", "max"] },
  { provider: "deepseek", modelId: "deepseek-v4-pro", levels: ["high", "max"] },
  // Meta Muse (slug "meta")
  { provider: "meta", modelId: "muse-wonder-1.0", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "meta", modelId: "muse-spark-1.3", levels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "meta", modelId: "muse-spark-1.1", levels: ["minimal", "low", "medium", "high", "xhigh"] },
  { provider: "meta", modelId: "muse-spark-1.2", levels: ["minimal", "low", "medium", "high", "xhigh"] },
];

const BY_KEY = new Map(ENTRIES.map((e) => [`${e.provider}\n${e.modelId}`, e]));

export function reasoningProfileFor(providerSlug: string, modelId: string): ReasoningProfile | null {
  const e = BY_KEY.get(`${providerSlug}\n${modelId}`);
  if (!e) return null;
  return { levels: [...e.levels], defaultLevel: "provider", source: "builtin" };
}
