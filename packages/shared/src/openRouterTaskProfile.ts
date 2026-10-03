import {
  type TaskClassificationSource,
  type TaskMacroCategory,
  type TaskProfileV0,
  OPENROUTER_TASK_PROFILE_VERSION,
  UNKNOWN_TASK_PROFILE,
} from "@t3tools/contracts";

const PREFIX_RULES: ReadonlyArray<{ readonly prefix: string; readonly macro: TaskMacroCategory }> =
  [
    { prefix: "code:debug", macro: "debugging" },
    { prefix: "code:", macro: "coding" },
    { prefix: "agent:", macro: "multi_step_agent" },
    { prefix: "research", macro: "research" },
    { prefix: "math", macro: "mathematics" },
    { prefix: "qa", macro: "simple_qa" },
    { prefix: "summar", macro: "summarization" },
    { prefix: "data", macro: "data_analysis" },
    { prefix: "writ", macro: "writing" },
    { prefix: "reason", macro: "reasoning" },
  ];

const HEURISTIC_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly macro: TaskMacroCategory;
}> = [
  { pattern: /\b(debug|stack trace|exception|repro|fix the bug)\b/i, macro: "debugging" },
  { pattern: /\b(implement|refactor|codegen|typescript|python function)\b/i, macro: "coding" },
  { pattern: /\b(multi-step|playbook|agent loop|plan then execute)\b/i, macro: "multi_step_agent" },
  { pattern: /\b(research|literature|sources for)\b/i, macro: "research" },
  { pattern: /\b(prove|reason about|why does this)\b/i, macro: "reasoning" },
  { pattern: /\b(integral|derivative|equation|theorem)\b/i, macro: "mathematics" },
  { pattern: /\b(summarize|tldr|tl;dr)\b/i, macro: "summarization" },
  { pattern: /\b(what is|who is|when did)\b/i, macro: "simple_qa" },
  { pattern: /\b(draft|write an email|rewrite this)\b/i, macro: "writing" },
  { pattern: /\b(csv|dataframe|plot this|analyze the data)\b/i, macro: "data_analysis" },
];

const normalizeTag = (tag: string): string => tag.trim().toLowerCase();

export const taskMacroFromOpenRouterTag = (tag: string): TaskMacroCategory => {
  const normalized = normalizeTag(tag);
  if (normalized.length === 0) return "unknown";
  for (const rule of PREFIX_RULES) {
    if (normalized.startsWith(rule.prefix)) return rule.macro;
  }
  return "other";
};

export const taskProfileFromOpenRouterTag = (input: {
  readonly tag: string | null | undefined;
  readonly source?: Exclude<TaskClassificationSource, "local_heuristic" | "unknown">;
  readonly confidence?: number;
}): TaskProfileV0 => {
  if (input.tag === null || input.tag === undefined || input.tag.trim().length === 0) {
    return UNKNOWN_TASK_PROFILE;
  }
  return {
    version: OPENROUTER_TASK_PROFILE_VERSION,
    macroCategory: taskMacroFromOpenRouterTag(input.tag),
    rawExternalTag: input.tag.trim(),
    source: input.source ?? "openrouter_auto",
    ...(input.confidence !== undefined && Number.isFinite(input.confidence)
      ? { confidence: input.confidence }
      : {}),
  };
};

export const taskProfileFromLocalHeuristic = (prompt: string): TaskProfileV0 => {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return UNKNOWN_TASK_PROFILE;
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        version: OPENROUTER_TASK_PROFILE_VERSION,
        macroCategory: rule.macro,
        source: "local_heuristic",
        heuristic: true,
      };
    }
  }
  return {
    version: OPENROUTER_TASK_PROFILE_VERSION,
    macroCategory: "unknown",
    source: "local_heuristic",
    heuristic: true,
  };
};

export const extractOpenRouterTaskType = (metadata: unknown): string | undefined => {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const pipeline = (metadata as { readonly pipeline?: unknown }).pipeline;
  if (!Array.isArray(pipeline)) return undefined;
  for (const stage of pipeline) {
    if (stage === null || typeof stage !== "object") continue;
    const data = (stage as { readonly data?: unknown }).data;
    if (data === null || typeof data !== "object") continue;
    const taskType = (data as { readonly task_type?: unknown }).task_type;
    if (typeof taskType === "string" && taskType.trim().length > 0) return taskType.trim();
  }
  return undefined;
};
