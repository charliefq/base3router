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

// Han/mixed requests use explicit clause-head intent, not English technical topic nouns.
// Pure English retains the legacy rule order below. This is a bounded heuristic, not NLP
// or evidence of model quality; conflicting explicit intent families remain unknown.
const REQUEST_PREFIX = String.raw`(?:(?:然后|接着|再|并且|并)\s*|(?:and|then)\s+)?(?:(?:请(?:你)?(?:帮我)?|麻烦(?:你)?(?:帮我)?|帮我|能否(?:帮我)?|可以(?:帮我)?)\s*)?(?:先\s*)?(?:please\s+)?`;
const stripRequestPrefix = new RegExp(`^${REQUEST_PREFIX}`, "iu");
const objectContext = String.raw`[^，,。！？!?；;\n]{0,120}`;
const failureContext = String.raw`(?:异常|错误|报错|故障|崩溃|空指针|漏洞|\b(?:bug|exception|stack trace)\b)`;
const codingContext = String.raw`(?:代码|函数|组件|接口|程序|脚本|单元测试|测试|\b(?:api|unit tests?)\b)`;
const dataContext = String.raw`(?:数据(?!库|结构|类型|中心|接口)|表格|报表|销量|销售额|营收|指标|\b(?:data|csv|dataframe)\b)`;

const HAN_INTENT_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly macro: TaskMacroCategory;
}> = [
  {
    pattern: new RegExp(`^(?:修复|排查|定位|解决)${objectContext}${failureContext}`, "iu"),
    macro: "debugging",
  },
  { pattern: /^调试\s*\S/u, macro: "debugging" },
  {
    pattern: new RegExp(`^(?:实现|重构|开发|编写|添加|写)${objectContext}${codingContext}`, "iu"),
    macro: "coding",
  },
  { pattern: /^(?:总结|概括|汇总)(?!\s*(?:是|能力|的|一词))\s*\S/u, macro: "summarization" },
  {
    pattern: new RegExp(
      `^(?:起草|撰写|写|编写|改写|润色)${objectContext}(?:邮件|信件|文案|文章|报告|公告|说明|发言稿|计划|介绍)`,
      "u",
    ),
    macro: "writing",
  },
  {
    pattern: new RegExp(
      `^(?:分析|统计|可视化|比较|对比|绘制|画)${objectContext}${dataContext}`,
      "iu",
    ),
    macro: "data_analysis",
  },
  {
    pattern: /^(?:调研|研究|检索|查证)(?!\s*(?:报告|表明|显示|成果|能力|方法|方向|现状))\s*\S/u,
    macro: "research",
  },
  { pattern: /^(?:debug|fix\s+(?:(?:the|this|a)\s+)?bug)\b/i, macro: "debugging" },
  { pattern: /^(?:implement|refactor|codegen)\b/i, macro: "coding" },
  { pattern: /^plan then execute\b/i, macro: "multi_step_agent" },
  { pattern: /^(?:research|find sources|sources for)\b/i, macro: "research" },
  { pattern: /^(?:prove|reason about|why does this)\b/i, macro: "reasoning" },
  {
    pattern: /^(?:solve|calculate)\b.*\b(?:integral|derivative|equation|theorem)\b/i,
    macro: "mathematics",
  },
  { pattern: /^(?:summari[sz]e|tldr)\b/i, macro: "summarization" },
  { pattern: /^(?:what is|who is|when did)\b/i, macro: "simple_qa" },
  { pattern: /^(?:draft|rewrite|write\s+(?:an?\s+)?email)\b/i, macro: "writing" },
  {
    pattern: new RegExp(`^(?:analy[sz]e|plot)\\b${objectContext}${dataContext}`, "iu"),
    macro: "data_analysis",
  },
];
const requestVerbs = String.raw`(?:修复|排查|定位|解决|调试|实现|重构|开发|编写|添加|写|总结|概括|汇总|起草|撰写|改写|润色|分析|统计|可视化|比较|对比|绘制|画|调研|研究|检索|查证|debug\b|fix\b|implement\b|refactor\b|research\b|summari[sz]e\b|draft\b|rewrite\b|analy[sz]e\b|plot\b)`;
const compoundRequest = new RegExp(
  String.raw`(?:然后|接着|并且|并|再)\s*(?=${REQUEST_PREFIX}${requestVerbs})|\b(?:and|then)\s+(?=${REQUEST_PREFIX}${requestVerbs})`,
  "iu",
);
const requestCategories = (text: string) =>
  HAN_INTENT_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.macro);
const hanRequestCategory = (text: string): TaskMacroCategory => {
  const categories = new Set<TaskMacroCategory>();
  for (const sentence of text.split(/[，,。！？!?；;\n]+/u)) {
    const request = sentence.trim().replace(stripRequestPrefix, "");
    // Do not discover an imperative by splitting unsupported prose or a negated head.
    if (requestCategories(request).length === 0) continue;
    for (const part of request.split(compoundRequest)) {
      for (const category of requestCategories(part.trim().replace(stripRequestPrefix, "")))
        categories.add(category);
    }
  }
  return categories.size === 1 ? categories.values().next().value! : "unknown";
};

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
  if (/\p{Script=Han}/u.test(trimmed))
    return {
      version: OPENROUTER_TASK_PROFILE_VERSION,
      macroCategory: hanRequestCategory(trimmed),
      source: "local_heuristic",
      heuristic: true,
    };
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
