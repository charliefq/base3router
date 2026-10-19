import { expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  EnvironmentId,
  LOCAL_TASK_CLASSIFIER_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  type TaskFirstLaunch,
  type TaskAutoPreviewInput,
  type ModelRouterConstraints,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
function value<A>(result: { _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown }): A {
  if (result._tag !== "Success") throw new Error(String(result.cause));
  return result.value;
}
const cases = [
  { category: "debugging", text: "修复登录页面的空指针异常" },
  { category: "coding", text: "实现一个分页组件并添加单元测试" },
  { category: "summarization", text: "总结这份产品需求文档" },
  { category: "writing", text: "请起草一封项目进度邮件" },
  { category: "data_analysis", text: "分析这组销售数据并画图" },
  { category: "research", text: "调研这些方案并提供来源" },
] as const;
const catalog = (f: Fixture) => [
  {
    ...f.providers[0]!,
    models: f.providers[0]!.models.filter((model) =>
      ["bbb-auto", "exact-second"].includes(model.slug),
    ),
  },
];
async function prepare(f: Fixture, key: string, text: string) {
  const create: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
    type: "thread.create",
    commandId: CommandId.make(`create-${key}`),
    threadId: ThreadId.make(`thread-${key}`),
    projectId: ProjectId.make("project-a"),
    title: "Chinese intent fixture",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "bbb-auto" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    taskGovernance: "required",
    taskContract: {
      goal: "Preserve original fixture Goal",
      redirect: "Disposable fake adapters only",
      acceptance: "Human review of actual output",
      brake: { maxProviderStarts: 1, stopConditions: "No successor" },
    },
    taskCreationReview: {
      environmentId: EnvironmentId.make("environment-a"),
      projectId: ProjectId.make("project-a"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "bbb-auto" },
    },
  };
  value(await f.create(create));
  const task = (await f.snapshot()).tasks.find((task) => task.threadId === create.threadId)!;
  const facts = value(
    await f.review({
      environmentId: "environment-a",
      projectId: create.projectId,
      taskId: task.id,
      threadId: create.threadId,
      revision: 1,
    }),
  );
  if (facts.status !== "available") throw new Error("Missing owned facts");
  const marker: TaskFirstLaunch = {
    commandId: CommandId.make(`start-${key}`),
    messageId: MessageId.make(`message-${key}`),
    threadId: create.threadId,
    reference: facts.reference,
    contract: facts.contract,
    text,
    routingMode: "auto",
    modelSelection: create.modelSelection,
    runtimeMode: create.runtimeMode,
    interactionMode: create.interactionMode,
  };
  const preview: TaskAutoPreviewInput = {
    environmentId: facts.reference.environmentId,
    projectId: facts.reference.projectId,
    taskId: facts.reference.taskId,
    reference: facts.reference,
    threadId: create.threadId,
    revision: facts.contract.revision,
    text,
  };
  return { marker, preview };
}
function start(f: Fixture, marker: TaskFirstLaunch, constraints?: ModelRouterConstraints) {
  if (constraints)
    return f.dispatch({
      type: "message.dispatch",
      commandId: marker.commandId,
      threadId: marker.threadId,
      messageId: marker.messageId,
      text: marker.text,
      attachments: [],
      routingMode: marker.routingMode,
      modelSelection: marker.modelSelection,
      modelRouteConstraints: constraints,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  return f.start({
    commandId: marker.commandId,
    threadId: marker.threadId,
    message: { messageId: marker.messageId, role: "user", text: marker.text, attachments: [] },
    modelSelection: marker.modelSelection,
    routingMode: marker.routingMode,
    dispatchMode: "start",
    runtimeMode: marker.runtimeMode,
    interactionMode: marker.interactionMode,
    taskFirstLaunch: marker,
  });
}
async function readOnlyPreview(f: Fixture, input: TaskAutoPreviewInput) {
  const before = await f.routingEvidenceState();
  const work = await f.executionCounts();
  const starts = (await f.inspect()).starts.length;
  const preview = value(await f.previewAuto(input));
  expect(preview.status).toBe("available");
  if (preview.status !== "available") throw new Error(preview.reason);
  expect(await f.routingEvidenceState()).toEqual(before);
  expect(await f.executionCounts()).toEqual(work);
  expect((await f.inspect()).starts).toHaveLength(starts);
  return preview;
}
async function settledBinding(f: Fixture, marker: TaskFirstLaunch) {
  await f.settle(marker.messageId);
  const projection = value(await f.projection({ threadId: marker.threadId }));
  const message = projection.messages.find((message) => message.id === marker.messageId)!;
  expect(message).toBeDefined();
  return { projection, binding: await f.routingBinding(marker.threadId, marker.messageId) };
}
it.each(cases)(
  "authenticated Chinese $category preview is read-only and matches actual fake dispatch",
  async ({ category, text }) => {
    await withTaskTransportFixture(async (f) => {
      f.setProviders(catalog(f));
      await f.seedTaskRouting([
        { category, classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION, trials: 8 },
      ]);
      const p = await prepare(f, category, text);
      const before = await f.routingEvidenceState();
      const preview = await readOnlyPreview(f, p.preview);
      expect(preview.profile).toEqual({
        category,
        classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
        source: "local-heuristic",
      });
      expect(preview.decision.policyVersion).toBe(HYBRID_TASK_ROUTER_POLICY_VERSION);
      expect(preview.decision.selected?.target).toEqual({
        instanceId: "codex",
        model: "exact-second",
      });
      expect(preview.decision.explanation).toContain(
        `Local task ${category} (${LOCAL_TASK_CLASSIFIER_VERSION})`,
      );
      value(await start(f, p.marker));
      const { projection, binding } = await settledBinding(f, p.marker);
      expect(binding.localTaskProfile).toEqual(preview.profile);
      expect({ ...binding.modelRoute, executionStatus: "not-started" }).toEqual(preview.decision);
      expect(binding.hybrid).toEqual(preview.hybrid);
      expect((await f.inspect()).starts).toEqual([{ instanceId: "codex", model: "exact-second" }]);
      expect((await f.inspect()).inputs).toEqual([text]);
      expect(projection.thread.taskContract).toEqual(p.marker.contract);
      expect(projection.runs[0]?.status).toBe("completed");
      const after = await f.routingEvidenceState();
      for (const row of before.observations)
        expect(
          after.observations.find((current) => current.observation_id === row.observation_id),
        ).toEqual(row);
      expect(Object.keys(binding.localTaskProfile!)).toEqual([
        "classifierVersion",
        "category",
        "source",
      ]);
      expect(JSON.stringify(binding.localTaskProfile)).not.toContain(text);
      expect(binding.localTaskProfile).not.toHaveProperty("confidence");
    });
  },
);
it.each(["none", "old", "seven", "mixed-old-new", "unknown"] as const)(
  "keeps truthful V0 fallback for %s evidence without rewriting cohorts",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      f.setProviders(catalog(f));
      const profiles =
        mode === "none"
          ? []
          : mode === "old"
            ? [
                {
                  category: "debugging" as const,
                  classifierVersion: "local-task.heuristic.v1.0.0",
                  trials: 8,
                },
              ]
            : mode === "mixed-old-new"
              ? [
                  {
                    category: "debugging" as const,
                    classifierVersion: "local-task.heuristic.v1.0.0",
                    trials: 8,
                  },
                  {
                    category: "debugging" as const,
                    classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
                    trials: 7,
                  },
                ]
              : [
                  {
                    category: "debugging" as const,
                    classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION,
                    trials: mode === "seven" ? 7 : 8,
                  },
                ];
      await f.seedTaskRouting(profiles);
      const text = mode === "unknown" ? "分析数据库连接错误" : "修复登录页面的空指针异常";
      const p = await prepare(f, `fallback-${mode}`, text);
      const before = await f.routingEvidenceState();
      const preview = await readOnlyPreview(f, p.preview);
      expect(preview.profile.category).toBe(mode === "unknown" ? "unknown" : "debugging");
      expect(preview.decision.policyVersion).toBe(MODEL_ROUTER_POLICY_VERSION);
      expect(preview.hybrid?.fallbackToV0).toBe(true);
      expect(preview.hybrid?.usedHybridRanking).toBe(false);
      expect(preview.hybrid?.fallbackReason).toContain(mode === "unknown" ? "unknown" : "coverage");
      expect(preview.decision.selected?.target.model).toBe("bbb-auto");
      value(await start(f, p.marker));
      const { binding } = await settledBinding(f, p.marker);
      expect({ ...binding.modelRoute, executionStatus: "not-started" }).toEqual(preview.decision);
      expect(binding.localTaskProfile).toEqual(preview.profile);
      expect((await f.inspect()).starts).toEqual([{ instanceId: "codex", model: "bbb-auto" }]);
      const after = await f.routingEvidenceState();
      for (const row of before.observations)
        expect(
          after.observations.find((current) => current.observation_id === row.observation_id),
        ).toEqual(row);
    });
  },
);
it("keeps Manual exact target despite eligible Chinese task evidence favoring another model", async () => {
  await withTaskTransportFixture(async (f) => {
    f.setProviders(catalog(f));
    await f.seedTaskRouting([
      { category: "coding", classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION, trials: 8 },
    ]);
    const p = await prepare(f, "manual", "实现分页组件并添加单元测试");
    const preview = await readOnlyPreview(f, p.preview);
    expect(preview.decision.selected?.target.model).toBe("exact-second");
    const marker = { ...p.marker, routingMode: "manual" as const };
    value(await start(f, marker));
    const { binding } = await settledBinding(f, marker);
    expect(binding.modelRoute?.mode).toBe("manual");
    expect(binding.target).toEqual({ instanceId: "codex", model: "bbb-auto" });
    expect(binding.hybrid?.usedHybridRanking).toBe(false);
    expect((await f.inspect()).starts).toEqual([{ instanceId: "codex", model: "bbb-auto" }]);
  });
});
it.each(["legal-code", "impossible", "unavailable-after-preview"] as const)(
  "preserves capability and availability constraints: %s",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const providers = catalog(f);
      f.setProviders(providers);
      await f.seedTaskRouting([
        { category: "coding", classifierVersion: LOCAL_TASK_CLASSIFIER_VERSION, trials: 8 },
      ]);
      const p = await prepare(f, mode, "实现一个分页组件并添加单元测试");
      const constraints: ModelRouterConstraints =
        mode === "impossible"
          ? { requiredCapabilities: ["vision"] }
          : { requiredCapabilities: ["code"], allowedModels: ["bbb-auto"] };
      const preview = await readOnlyPreview(f, { ...p.preview, constraints });
      if (mode === "impossible") expect(preview.decision.selected).toBeNull();
      else expect(preview.decision.selected?.target.model).toBe("bbb-auto");
      const before = await f.executionCounts();
      if (mode === "unavailable-after-preview")
        f.setProviders(providers.map((provider) => ({ ...provider, installed: false })));
      const result = await start(f, p.marker, constraints);
      if (mode !== "legal-code") {
        expect(result._tag).toBe("Failure");
        expect(await f.executionCounts()).toEqual(before);
        expect((await f.inspect()).starts).toHaveLength(0);
        return;
      }
      value(result);
      const { binding } = await settledBinding(f, p.marker);
      expect({ ...binding.modelRoute, executionStatus: "not-started" }).toEqual(preview.decision);
      expect((await f.inspect()).starts).toEqual([{ instanceId: "codex", model: "bbb-auto" }]);
    });
  },
);
