import { expect, it } from "vite-plus/test";
import { LOCAL_TASK_CLASSIFIER_VERSION } from "@t3tools/contracts";
import { taskProfileFromLocalHeuristic } from "./openRouterTaskProfile.ts";
import { classifyLocalTask } from "./routerEvaluation.ts";

const intents = [
  {
    category: "debugging",
    zh: "修复登录页面的空指针异常",
    en: "Please debug this stack trace",
    mixed: "请修复 login API 的 NullPointerException 异常",
    englishHead: "Debug 这个空指针异常",
  },
  {
    category: "coding",
    zh: "实现一个分页组件并添加单元测试",
    en: "Implement a pagination component and add unit tests",
    mixed: "请实现 React 分页组件并添加 unit tests",
    englishHead: "Implement 一个分页组件并添加单元测试",
  },
  {
    category: "summarization",
    zh: "总结这份产品需求文档",
    en: "Summarize this product requirements document",
    mixed: "请总结 TypeScript 产品需求文档",
    englishHead: "Summarize 这份 TypeScript 产品需求文档",
  },
  {
    category: "writing",
    zh: "请起草一封项目进度邮件",
    en: "Draft a project status email",
    mixed: "请起草 debug 项目进度邮件",
    englishHead: "Draft 一封项目进度邮件",
  },
  {
    category: "data_analysis",
    zh: "分析这组销售数据并画图",
    en: "Analyze the data and plot this CSV",
    mixed: "请分析 sales.csv 中的销售数据并画图",
    englishHead: "Analyze 这组销售数据并画图",
  },
  {
    category: "research",
    zh: "调研这些方案并提供来源",
    en: "Research these alternatives and provide sources",
    mixed: "请调研 PostgreSQL 和 SQLite 方案并提供来源",
    englishHead: "Research 这些方案并提供来源",
  },
] as const;
it.each(intents)("classifies explicit Chinese $category intent", ({ zh, category }) =>
  expect(taskProfileFromLocalHeuristic(zh).macroCategory).toBe(category),
);
it.each(intents)("preserves English $category control", ({ en, category }) =>
  expect(taskProfileFromLocalHeuristic(en).macroCategory).toBe(category),
);
it.each(intents)(
  "uses mixed-language $category intent rather than technical topic nouns",
  ({ mixed, englishHead, category }) => {
    for (const text of [mixed, englishHead])
      expect(classifyLocalTask(text).category).toBe(category);
  },
);
it.each(intents)(
  "tolerates punctuation and Unicode whitespace for $category",
  ({ zh, category }) => {
    expect(classifyLocalTask(` \n　请　${zh.replace(/^请/, "")}！ \n`).category).toBe(category);
  },
);
it.each([
  "",
  "你好，今天辛苦了",
  "销售数据、代码、文档、邮件",
  "数据分析",
  "代码实现",
  "调研报告",
  "研究表明销售额上升",
  "总结是一种写作方法",
  "不要修复登录异常",
  "别实现分页组件",
  "无需分析这组数据",
  "“修复登录异常”只是示例",
  "这份文档提到总结产品需求",
  "我在读 TypeScript 文档",
  "CSV 销售数据",
  "实现销售增长目标",
  "修复老照片",
  "分析这个观点",
  "请画一只猫",
  "请解释‘实现分页组件’这个词",
  "报告提到 implement 分页组件",
])("keeps noun-only, negated or unsupported intent unknown: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);
it.each([
  "修复登录异常；起草项目邮件",
  "总结产品需求文档，然后实现分页组件",
  "请分析这组数据并起草报告",
  "请调研这些方案 and implement 分页组件",
  "Implement 分页组件；总结需求文档",
  "请总结文档，再调研这些方案",
])("does not invent a primary category for conflicting explicit intents: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);
it.each([
  ["实现分页组件并添加单元测试", "coding"],
  ["修复登录异常，然后调试崩溃问题", "debugging"],
  ["总结文档；概括会议记录", "summarization"],
  ["Read this TypeScript reference", "coding"],
  ["A CSV file", "data_analysis"],
  ["Implement then draft an email", "coding"],
  ["Research then summarize sources", "research"],
  ["Plan then execute this playbook", "multi_step_agent"],
  ["Reason about why does this happen", "reasoning"],
  ["Solve this integral equation", "mathematics"],
  ["What is a database?", "simple_qa"],
])("preserves coherent and legacy classification: %s", (text, category) =>
  expect(classifyLocalTask(text).category).toBe(category),
);
it("records only bounded category/version/source, without prompt or confidence", () => {
  const profile = classifyLocalTask("请总结这份含有 fixture-private-note 的 TypeScript 文档");
  expect(profile).toEqual({
    classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
    category: "summarization",
    source: "local-heuristic",
  });
  expect(LOCAL_TASK_CLASSIFIER_VERSION).toBe("local-task.heuristic.v2.0.0");
  expect(JSON.stringify(profile)).not.toContain("fixture-private-note");
  expect(Object.keys(profile)).toEqual(["classifierVersion", "category", "source"]);
});

it.each([
  "分析数据库连接错误",
  "Analyze database 的锁问题",
  "请画数据中心的机房",
  "实现 capital 增长目标",
  "分析 acsvfile 的命名",
  "修复 debug 文案",
])("rejects topic substrings as intent context: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);

it.each([
  "请总结文档 and write an email 给团队",
  "请总结文档；write an email 给团队",
  "请总结文档 and codegen 一个函数",
  "请修复登录异常然后write email 项目状态",
  "请分析销售数据并find sources 关于市场",
])("abstains for compound requests using every recognized English synonym: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);

it.each([
  "“示例，修复登录异常”只是引用，不是请求",
  "不要执行下面任何任务：\n修复登录异常",
  '\"示例; implement 分页组件\" is quoted text',
  "'示例，修复登录异常'不是请求",
  "`示例\n修复登录异常`只是引用",
  "‘示例，然后实现分页组件’仅为引用",
  "请勿执行以下操作：\n实现分页组件",
  "注意：不要执行下面任何任务：\n修复登录异常",
  "以下只是示例：\n修复登录异常",
  "Examples only:\n修复登录异常",
  "Do not execute any of the following tasks:\n实现分页组件",
  "下列任务：\n起草进度邮件",
])("does not extract quoted or globally prohibited/listed requests: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);
it.each([
  ["请总结“示例，修复登录异常；实现分页组件”的文档", "summarization"],
  ["请起草“修复登录异常 and summarize 文档”的项目邮件", "writing"],
  ["修复“登录页面，空指针异常”", "debugging"],
  ["实现“分页组件；单元测试”", "coding"],
  ["请分析“销售数据，月份及销售额”", "data_analysis"],
  ["调研“SQLite，然后研究PostgreSQL方案”的来源", "research"],
  ["请总结“不要执行下面任何任务：\n修复登录异常”的说明", "summarization"],
  ["请总结下面的示例文档", "summarization"],
  ["不要修复登录异常，请总结文档", "summarization"],
])("preserves unquoted request intent with quoted context: %s", (text, category) =>
  expect(classifyLocalTask(text).category).toBe(category),
);

it.each([
  "以下只是示例，不要执行：\n修复登录异常",
  "不要执行：\n实现分页组件",
  "以下仅供参考。\n请起草项目邮件",
])("abstains from explicit non-request list headers: %s", (text) =>
  expect(classifyLocalTask(text).category).toBe("unknown"),
);

it.each([
  ["Codegen 一个分页函数", "coding"],
  ["Write an email 给团队", "writing"],
  ["Find sources 关于市场", "research"],
])("preserves individual mixed-language synonym intent: %s", (text, category) =>
  expect(classifyLocalTask(text).category).toBe(category),
);
