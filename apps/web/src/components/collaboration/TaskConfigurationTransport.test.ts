import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type WorkflowActionInput,
  type AgentProfile,
} from "@t3tools/contracts";
import { configurationSnapshot, configurationInput } from "@t3tools/shared/agentConfiguration";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
const creation = (key: string): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${key}`),
  threadId: ThreadId.make(`transport-${key}`),
  projectId: ProjectId.make("project-a"),
  title: `Transport ${key}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: {
    goal: "Prove transport",
    redirect: "Keep fixture scope",
    acceptance: "Owner reads actual linked output",
    brake: { maxProviderStarts: 3, stopConditions: "Scope changed" },
  },
  taskCreationReview: {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  },
});
type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
const save = (id = "careful-reviewer"): Extract<WorkflowActionInput, { type: "profile.save" }> => ({
  type: "profile.save",
  commandId: `save-${id}`,
  projectId: ProjectId.make("project-a"),
  expectedVersion: 0,
  draft: {
    id,
    displayName: id,
    instructions: "Use the exact visible instructions.",
    description: "Saved configuration",
    purpose: "Ordinary task input",
    responsibilities: [],
    exclusions: [],
    requiredOutputSections: ["Result"],
    artifactKind: "task-input",
    capabilityPreferences: [],
    taskConfiguration: {
      environmentId: EnvironmentId.make("environment-a"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
    },
  },
});
async function saved(f: Fixture, input = save()) {
  const result = await f.configuration(input);
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") throw new Error(String(result.cause));
  return result.value.profiles.find(
    (p) => p.id === input.draft.id && p.version === input.expectedVersion + 1,
  )!;
}
function configured(key: string, profile: AgentProfile) {
  const c = creation(key);
  const snapshot = configurationSnapshot(profile)!;
  return {
    ...c,
    taskCreationReview: {
      ...c.taskCreationReview!,
      configuration: snapshot,
      effectiveInstructions: configurationInput(snapshot.instructions, c.taskContract!.goal),
    },
  };
}
it("one saved configuration creates two distinct governed owned tasks, freezes revision, and explicitly launches exact visible input", async () => {
  await withTaskTransportFixture(async (f) => {
    const input = save();
    const profile = await saved(f, input);
    const second = await saved(f, save("another-name-same-provider"));
    expect(second.taskConfiguration!.modelSelection).toEqual(
      profile.taskConfiguration!.modelSelection,
    );
    expect(await f.configurationStatus(input)).toMatchObject({
      _tag: "Success",
      value: "committed",
    });
    const one = configured("configured-one", profile),
      two = configured("configured-two", profile);
    expect((await f.create(one))._tag).toBe("Success");
    expect((await f.create(two))._tag).toBe("Success");
    const tasks = (await f.snapshot()).tasks;
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.threadId)).size).toBe(2);
    expect(
      tasks.every((t) => t.ownerAgentId === "fixture-owner" && t.assigneeAgentId === "codex"),
    ).toBe(true);
    expect((await f.inspect()).starts).toHaveLength(0);
    await saved(f, {
      ...input,
      commandId: "edit-configuration",
      expectedVersion: 1,
      draft: { ...input.draft, instructions: "New content applies to future drafts only." },
    });
    expect((await f.create(configured("stale", profile)))._tag).toBe("Failure");
    expect(
      (
        await f.configuration({
          type: "profile.archive",
          commandId: "archive-future-revision",
          projectId: input.projectId,
          profileId: profile.id,
          expectedVersion: 2,
        })
      )._tag,
    ).toBe("Success");
    const projection = await f.projection({ threadId: one.threadId });
    if (projection._tag !== "Success") throw new Error("No projection");
    expect(projection.value.thread.agentsTaskCreation!.review.configuration!.revision).toBe(1);
    expect(projection.value.thread.agentsTaskCreation!.review.effectiveInstructions).toBe(
      one.taskCreationReview.effectiveInstructions,
    );
    expect(await f.creationStatus({ command: one })).toMatchObject({
      _tag: "Success",
      value: { status: "committed" },
    });
    const task = tasks.find((t) => t.threadId === one.threadId)!;
    const review = await f.review({
      environmentId: "environment-a",
      taskId: task.id,
      projectId: one.projectId,
      threadId: one.threadId,
      revision: 1,
    });
    if (review._tag !== "Success" || review.value.status !== "available")
      throw new Error("No review");
    const text = one.taskCreationReview.effectiveInstructions!;
    const marker = {
      commandId: CommandId.make("configuration-launch"),
      messageId: MessageId.make("configuration-message"),
      threadId: one.threadId,
      reference: review.value.reference,
      contract: review.value.contract,
      text,
      routingMode: "manual" as const,
      modelSelection: one.modelSelection,
      runtimeMode: one.runtimeMode,
      interactionMode: one.interactionMode,
    };
    const args = {
      commandId: marker.commandId,
      threadId: one.threadId,
      message: { messageId: marker.messageId, role: "user" as const, text, attachments: [] },
      modelSelection: one.modelSelection,
      routingMode: "manual" as const,
      runtimeMode: one.runtimeMode,
      interactionMode: one.interactionMode,
      dispatchMode: "start" as const,
      taskFirstLaunch: marker,
    };
    expect(
      (
        await f.start({
          ...args,
          commandId: CommandId.make("forged-input"),
          message: { ...args.message, text: "Replaced input" },
          taskFirstLaunch: {
            ...marker,
            commandId: CommandId.make("forged-input"),
            text: "Replaced input",
          },
        })
      )._tag,
    ).toBe("Failure");
    expect((await f.start(args))._tag).toBe("Success");
    await f.drain();
    expect((await f.inspect()).inputs).toEqual([text]);
    const after = await f.projection({ threadId: one.threadId });
    if (after._tag !== "Success") throw new Error("No result");
    expect(after.value.runs[0]!.status).toBe("completed");
    expect(after.value.thread.agentsTaskCreation!.review.configuration).toEqual(
      one.taskCreationReview.configuration,
    );
  });
}, 30000);
it("configuration revisions, archive, forged snapshots, cross owner/environment/project and unavailable model fail closed", async () => {
  await withTaskTransportFixture(async (f) => {
    const input = save();
    const profile = await saved(f, input);
    const base = configured("forged-name", profile);
    expect(
      (
        await f.create({
          ...base,
          taskCreationReview: {
            ...base.taskCreationReview,
            configuration: { ...base.taskCreationReview.configuration!, name: "Forged name" },
          },
        })
      )._tag,
    ).toBe("Failure");
    expect(
      (
        await f.create({
          ...configured("wrong-project", profile),
          projectId: ProjectId.make("project-b"),
          taskCreationReview: {
            ...base.taskCreationReview,
            projectId: ProjectId.make("project-b"),
          },
        })
      )._tag,
    ).toBe("Failure");
    expect(
      (
        await f.configuration({
          ...input,
          commandId: "wrong-environment",
          draft: {
            ...input.draft,
            id: "other-env",
            taskConfiguration: {
              ...input.draft.taskConfiguration!,
              environmentId: EnvironmentId.make("other"),
            },
          },
        })
      )._tag,
    ).toBe("Failure");
    await f.disconnect();
    await f.connectAs("other-owner");
    expect((await f.create(configured("wrong-owner", profile)))._tag).toBe("Failure");
    expect(
      (await f.configuration({ ...input, commandId: "overwrite-other-owner", expectedVersion: 1 }))
        ._tag,
    ).toBe("Failure");
    expect((await f.configurationStatus(input))._tag).toBe("Failure");
    const hidden = await f.catalog({ projectId: ProjectId.make("project-a") });
    expect(hidden).toMatchObject({ _tag: "Success" });
    if (hidden._tag === "Success")
      expect(hidden.value.profiles.some((p) => p.id === profile.id)).toBe(false);
    await f.disconnect();
    await f.connect();
    expect(
      (await f.configuration({ ...input, commandId: "stale-edit", expectedVersion: 0 }))._tag,
    ).toBe("Failure");
    const archive: WorkflowActionInput = {
      type: "profile.archive",
      commandId: "archive-original",
      projectId: input.projectId,
      profileId: profile.id,
      expectedVersion: 1,
    };
    expect((await f.configuration(archive))._tag).toBe("Success");
    expect(await f.configurationStatus(archive)).toMatchObject({
      _tag: "Success",
      value: "committed",
    });
    expect((await f.create(configured("archived", profile)))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);
it("lost committed configuration reply reconciles original command after reconnect without resend; never-sent identity stays UNKNOWN", async () => {
  await withTaskTransportFixture(async (f) => {
    const input = save();
    f.dropNextReply();
    const pending = f.configuration(input);
    await Promise.race([
      f.awaitDroppedReply(),
      pending.then(() => {
        throw new Error("Reply was not dropped");
      }),
    ]);
    await f.disconnect();
    await pending;
    await f.connect();
    expect(await f.configurationStatus(input)).toMatchObject({
      _tag: "Success",
      value: "committed",
    });
    expect(
      await f.configurationStatus({
        ...input,
        commandId: "never-sent",
        draft: { ...input.draft, id: "never-sent" },
      }),
    ).toMatchObject({ _tag: "Success", value: "unknown" });
    expect(
      await f.configurationStatus({
        ...input,
        draft: { ...input.draft, instructions: "Forged original command" },
      }),
    ).toMatchObject({ _tag: "Success", value: "conflict" });
    const catalog = await f.catalog({ projectId: input.projectId });
    if (catalog._tag !== "Success") throw new Error("No catalog");
    expect(catalog.value.profiles.filter((p) => p.id === input.draft.id)).toHaveLength(1);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it.each(["read-only", "revoked", "unavailable-model"])(
  "configuration authority rejects %s without provider work",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const input = save();
      if (kind === "read-only") {
        await f.disconnect();
        await f.connect(["orchestration:read"]);
      } else if (kind === "revoked") await f.revokeCurrent();
      else
        f.setProviders([
          {
            ...f.providers[0]!,
            models: f.providers[0]!.models.filter((m) => m.slug !== "exact-second"),
          },
        ]);
      expect((await f.configuration(input))._tag).toBe("Failure");
      expect((await f.workflowAction(input))._tag).toBe("Failure");
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);

it("duplicate configuration commands are idempotent and competing revision writes cannot overwrite one another", async () => {
  await withTaskTransportFixture(async (f) => {
    const input = save();
    const duplicate = await Promise.all([f.configuration(input), f.configuration(input)]);
    expect(duplicate.map((r) => r._tag)).toEqual(["Success", "Success"]);
    const revisions = await Promise.all([
      f.configuration({
        ...input,
        commandId: "revision-left",
        expectedVersion: 1,
        draft: { ...input.draft, instructions: "Left revision." },
      }),
      f.configuration({
        ...input,
        commandId: "revision-right",
        expectedVersion: 1,
        draft: { ...input.draft, instructions: "Right revision." },
      }),
    ]);
    expect(revisions.map((r) => r._tag).sort()).toEqual(["Failure", "Success"]);
    const catalog = await f.catalog({ projectId: input.projectId });
    if (catalog._tag !== "Success") throw new Error("No catalogue");
    expect(
      catalog.value.profiles
        .filter((p) => p.id === input.draft.id)
        .map((p) => p.version)
        .sort(),
    ).toEqual([1, 2]);
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);

it("raw forged configuration action is denied by server authority even when bypassing client review", async () => {
  await withTaskTransportFixture(async (f) => {
    const input = save();
    await saved(f, input);
    await f.disconnect();
    await f.connectAs("different-owner");
    expect(
      (await f.workflowAction({ ...input, commandId: "raw-other-owner", expectedVersion: 1 }))._tag,
    ).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(0);
  });
}, 30000);
