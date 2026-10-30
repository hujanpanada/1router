export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ReasoningProfile {
  levels: ThinkingLevel[];
  defaultLevel: ThinkingLevel | "provider";
  source?: "manual";
}

export interface ModelCapability {
  modelId: string;
  /** Safe default is false: 1Router only forwards images when explicitly allowed. */
  imageInput: boolean;
  /** Only explicit true enables thinking controls/request fields. */
  thinking: boolean;
  reasoning: ReasoningProfile | null;
  defaultEffort: ThinkingLevel | "provider";
}

/**
 * Resolve only what the user explicitly configured. 1Router deliberately
 * does not match providers/models to built-in profiles: provider model
 * names change too often, and a wrong guess is worse than "not set".
 */
export function capabilityFor(_providerSlug: string, modelId: string, stored?: { imageInput: boolean | null; thinking?: boolean | null; reasoning: ReasoningProfile | null }): ModelCapability {
  const thinking = stored?.thinking === true;
  const reasoning = thinking ? stored?.reasoning ?? null : null;
  return {
    modelId,
    imageInput: stored?.imageInput === true,
    thinking,
    reasoning: reasoning
      ? { levels: [...reasoning.levels], defaultLevel: reasoning.defaultLevel ?? "provider", source: "manual" }
      : null,
    defaultEffort: thinking ? reasoning?.defaultLevel ?? "provider" : "provider",
  };
}

export function validateReasoning(raw: unknown, where: string): ReasoningProfile | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new Error(`Invalid reasoning profile for ${where}`);
  const levelsIn = (raw as any).levels;
  if (!Array.isArray(levelsIn)) throw new Error(`Invalid reasoning profile for ${where}: levels must be an array`);
  const levels: ThinkingLevel[] = [];
  for (const l of levelsIn) {
    const lvl = typeof l === "string" && (THINKING_LEVELS as readonly string[]).includes(l) ? (l as ThinkingLevel) : null;
    if (!lvl || lvl === "off") throw new Error(`Invalid reasoning level "${String(l)}" for ${where} (use: minimal, low, medium, high, xhigh, max)`);
    if (!levels.includes(lvl)) levels.push(lvl);
  }
  const order: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  levels.sort((a, b) => order[a] - order[b]);
  const dflt = (raw as any).defaultLevel ?? "provider";
  if (dflt !== "provider" && !(typeof dflt === "string" && levels.includes(dflt as ThinkingLevel))) {
    throw new Error(`Invalid reasoning defaultLevel for ${where}: must be "provider" or one of its levels`);
  }
  return { levels, defaultLevel: dflt, source: "manual" };
}
