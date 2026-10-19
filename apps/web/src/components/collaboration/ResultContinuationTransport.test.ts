import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type TaskResultContinuation,
} from "@t3tools/contracts";
import { configurationInput, configurationSnapshot } from "@t3tools/shared/agentConfiguration";
import { digestCanonical } from "@t3tools/shared/actionCanonical";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
import { creation, send, completed, continuation } from "./testkit/resultContinuationJourney";
it.each(["manual", "auto"] as const)(
  "actual %s continuation explicitly starts one new attributed result in the same task",
  async (mode) => {
    await withTaskTransportFixture(async (f) => {
      const c = await completed(f, mode);
      const { m, facts } = await continuation(f, c, mode, mode);
      expect((await f.inspect()).starts).toHaveLength(1);
      if (mode === "auto")
        f.setProviders([
          {
            ...f.providers[0]!,
            models: [
              { ...f.providers[0]!.models[0]!, slug: "aaa-next-result", name: "Actual next Auto" },
              ...f.providers[0]!.models,
            ],
          },
        ]);
      const original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
        type: "message.dispatch",
        commandId: m.commandId,
        messageId: m.messageId,
        threadId: m.threadId,
        text: m.text,
        attachments: [],
        modelSelection: m.modelSelection,
        routingMode: m.routingMode,
        taskResultContinuation: m,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      };
      const outcome = await send(f, m, m);
      if (outcome._tag !== "Success") throw new Error(String(outcome.cause));
      expect(outcome._tag).toBe("Success");
      await f.settle(m.messageId);
      const proof = await f.continuationStatus({ command: original });
      expect(proof._tag).toBe("Success");
      if (proof._tag !== "Success" || proof.value.status !== "admitted")
        throw new Error("No original continuation receipt");
      expect(proof.value.runStatus).toBe("completed");
      expect(proof.value.runId).not.toBe(m.priorResult.runId);
      expect(proof.value.attemptId).not.toBe(m.priorResult.attemptId);
      expect(proof.value.resultPreview).toContain(`Transport answer: ${m.text}`);
      expect(proof.value.actualModelSelection.model).toBe(
        mode === "manual" ? "exact-second" : "aaa-next-result",
      );
      const projection = await f.projection({ threadId: c.threadId });
      if (projection._tag !== "Success") throw new Error("Missing result projection");
      expect(projection.value.runs).toHaveLength(2);
      expect(projection.value.messages).toHaveLength(2);
      expect(projection.value.thread.taskContract).toEqual(facts.projection.thread.taskContract);
      expect(projection.value.thread.taskAcceptedRevision).toBeNull();
      expect(
        projection.value.messages.find((v) => v.id === m.messageId)!.taskResultContinuation,
      ).toEqual(m);
      expect((await f.inspect()).inputs).toEqual(["First attributable output", m.text]);
      expect((await f.snapshot()).tasks).toHaveLength(1);
      await f.disconnect();
      await f.connect();
      expect(await f.continuationStatus({ command: original })).toEqual(proof);
      expect((await f.dispatch(original))._tag).toBe("Success");
      expect((await f.inspect()).starts).toHaveLength(2);
    });
  },
  30000,
);

it("full output mutation beyond the unchanged excerpt invalidates the reviewed continuation", async () => {
  await withTaskTransportFixture(async (f) => {
    const c = await completed(f, "full-output", "x".repeat(2200) + "original-tail");
    const { m, facts } = await continuation(f, c, "full-output");
    expect(facts.result.content.truncated).toBe(true);
    const item = facts.projection.turnItems.find((v) => v.id === m.priorResult.itemId)!;
    if (item.type !== "assistant_message") throw new Error("Not output");
    await f.alterLatestOutput(c.threadId, item.text.slice(0, -13) + "different-tail");
    const snapshot = await f.snapshot();
    const current = snapshot.tasks.find((t) => t.threadId === c.threadId)!;
    expect(current.resultReadout).toMatchObject({
      status: "available",
      content: { status: "output", preview: facts.result.content.preview, truncated: true },
    });
    expect((await send(f, m, m))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(1);
  });
}, 30000);
it("competing requests bound to one completed result admit only one, and the old result cannot start again", async () => {
  await withTaskTransportFixture(async (f) => {
    const c = await completed(f, "competing");
    const a = await continuation(f, c, "competing-a");
    const b = {
      ...a.m,
      commandId: CommandId.make("competing-b"),
      messageId: MessageId.make("competing-b"),
    };
    const replies = await Promise.all([send(f, a.m, a.m), send(f, b, b)]);
    expect(replies.map((r) => r._tag).sort()).toEqual(["Failure", "Success"]);
    const winner = replies[0]!._tag === "Success" ? a.m : b;
    await f.settle(winner.messageId);
    const stale = {
      ...a.m,
      commandId: CommandId.make("competing-late"),
      messageId: MessageId.make("competing-late"),
    };
    expect((await send(f, stale, stale))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(2);
  });
}, 30000);
it.each([
  "other owner",
  "wrong environment",
  "wrong project",
  "read only",
  "revoked",
  "withdrawn model",
])(
  "continuation refuses %s without another provider start",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const c = await completed(f, kind);
      const { m } = await continuation(f, c, kind);
      if (kind === "other owner") {
        await f.disconnect();
        await f.connectAs("other-owner");
      } else if (kind === "read only") {
        await f.disconnect();
        await f.connect(["orchestration:read"]);
      } else if (kind === "wrong environment") f.setEnvironment("other-environment");
      else if (kind === "wrong project") {
        const wrong = { ...m, reference: { ...m.reference, projectId: "other-project" } };
        expect((await send(f, wrong, wrong))._tag).toBe("Failure");
        expect((await f.inspect()).starts).toHaveLength(1);
        return;
      } else if (kind === "revoked") await f.revokeCurrent();
      else
        f.setProviders([
          {
            ...f.providers[0]!,
            models: f.providers[0]!.models.filter((v) => v.slug !== m.modelSelection.model),
          },
        ]);
      expect((await send(f, m, m))._tag).toBe("Failure");
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);
it.each(["pause", "accept", "contract"])(
  "current %s change invalidates the result-bound request",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const c = await completed(f, kind);
      const { m } = await continuation(f, c, kind);
      if (kind === "contract") {
        expect(
          (
            await f.dispatch({
              type: "thread.task-contract.redirect",
              commandId: CommandId.make("pause-for-edit"),
              threadId: c.threadId,
              revision: 1,
              reviewTask: m.reference,
            })
          )._tag,
        ).toBe("Success");
        const paused = await f.review({
          environmentId: "environment-a",
          taskId: m.reference.taskId,
          projectId: c.projectId,
          threadId: c.threadId,
          revision: 1,
        });
        if (paused._tag !== "Success" || paused.value.status !== "available")
          throw new Error("No paused review");
        expect(
          (
            await f.dispatch({
              type: "thread.task-contract.set",
              commandId: CommandId.make("change-contract"),
              threadId: c.threadId,
              expectedRevision: 1,
              reviewTask: paused.value.reference,
              goal: "Changed goal",
              redirect: m.contract.redirect,
              acceptance: m.contract.acceptance,
              brake: m.contract.brake,
            })
          )._tag,
        ).toBe("Success");
        const changed = await f.review({
          environmentId: "environment-a",
          taskId: m.reference.taskId,
          projectId: c.projectId,
          threadId: c.threadId,
          revision: 2,
        });
        if (changed._tag !== "Success" || changed.value.status !== "available")
          throw new Error("No changed review");
        if (changed.value.phase === "redirected")
          expect(
            (
              await f.dispatch({
                type: "thread.task-contract.resume",
                commandId: CommandId.make("resume-changed"),
                threadId: c.threadId,
                revision: 2,
                reviewTask: changed.value.reference,
              })
            )._tag,
          ).toBe("Success");
      } else {
        expect(
          (
            await f.dispatch({
              type:
                kind === "pause" ? "thread.task-contract.redirect" : "thread.task-contract.accept",
              commandId: CommandId.make(`change-${kind}`),
              threadId: c.threadId,
              revision: 1,
              reviewTask: m.reference,
            })
          )._tag,
        ).toBe("Success");
      }
      expect((await send(f, m, m))._tag).toBe("Failure");
      expect((await f.inspect()).starts).toHaveLength(1);
    });
  },
  30000,
);
it("lost continuation reply recovers its original identity read-only after reconnect; never-sent stays UNKNOWN", async () => {
  await withTaskTransportFixture(async (f) => {
    const c = await completed(f, "lost");
    const { m } = await continuation(f, c, "lost");
    f.dropNextReply();
    const pending = send(f, m, m);
    await Promise.race([
      f.awaitDroppedReply(),
      pending.then(() => {
        throw new Error("No dropped admitted reply");
      }),
    ]);
    await f.disconnect();
    await pending;
    await f.connect();
    await f.settle(m.messageId);
    const original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
      type: "message.dispatch",
      commandId: m.commandId,
      messageId: m.messageId,
      threadId: m.threadId,
      text: m.text,
      attachments: [],
      modelSelection: m.modelSelection,
      routingMode: m.routingMode,
      taskResultContinuation: m,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    };
    expect(await f.continuationStatus({ command: original })).toMatchObject({
      _tag: "Success",
      value: { status: "admitted", runStatus: "completed" },
    });
    const absent = {
      ...original,
      commandId: CommandId.make("never-sent"),
      messageId: MessageId.make("never-sent"),
      taskResultContinuation: {
        ...m,
        commandId: CommandId.make("never-sent"),
        messageId: MessageId.make("never-sent"),
      },
    };
    expect(await f.continuationStatus({ command: absent })).toMatchObject({
      _tag: "Success",
      value: { status: "unknown" },
    });
    expect((await f.inspect()).starts).toHaveLength(2);
  });
}, 30000);

it.each(["active turn", "background work", "failed latest run"])(
  "continuation refuses conflicting %s",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const c = await completed(f, kind);
      const { m } = await continuation(f, c, kind);
      if (kind === "background work") await f.alterBackgroundWork(c.threadId);
      else {
        const text = `Conflicting ${kind}`;
        if (kind === "active turn") f.holdInput(text);
        else f.failInput(text);
        const messageId = MessageId.make(`other-${kind}`);
        expect(
          (
            await f.start({
              commandId: CommandId.make(`other-${kind}`),
              threadId: c.threadId,
              message: { messageId, role: "user", text, attachments: [] },
              modelSelection: m.modelSelection,
              routingMode: "manual",
              runtimeMode: m.runtimeMode,
              interactionMode: m.interactionMode,
              dispatchMode: "start",
            })
          )._tag,
        ).toBe("Success");
        if (kind === "active turn") await f.awaitHeldStart();
        else await f.settle(messageId);
      }
      expect((await send(f, m, m))._tag).toBe("Failure");
      if (kind === "active turn") {
        f.releaseHeldStart();
        await f.settle(`other-${kind}`);
      }
      expect((await f.inspect()).starts).toHaveLength(kind === "background work" ? 1 : 2);
    });
  },
  30000,
);

it("continuation preserves frozen configuration provenance and sends only the reviewed requested changes", async () => {
  await withTaskTransportFixture(async (f) => {
    const saved = await f.configuration({
      type: "profile.save",
      commandId: "save-historical-config",
      projectId: ProjectId.make("project-a"),
      expectedVersion: 0,
      draft: {
        id: "historical-input",
        displayName: "Historical input",
        description: "Task input",
        purpose: "Visible input",
        responsibilities: [],
        exclusions: [],
        instructions: "Frozen initial instructions.",
        requiredOutputSections: ["Result"],
        artifactKind: "task-input",
        capabilityPreferences: [],
        taskConfiguration: {
          environmentId: EnvironmentId.make("environment-a"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
        },
      },
    });
    if (saved._tag !== "Success") throw new Error("No configuration");
    const profile = saved.value.profiles.find((p) => p.id === "historical-input")!;
    const config = configurationSnapshot(profile)!;
    const draft = creation("historical");
    const initial = configurationInput(profile.instructions, draft.taskContract!.goal);
    const c = await completed(f, "historical", initial, {
      ...draft,
      taskCreationReview: {
        ...draft.taskCreationReview!,
        configuration: config,
        effectiveInstructions: initial,
      },
    });
    const { m, facts } = await continuation(f, c, "historical");
    expect((await send(f, m, m))._tag).toBe("Success");
    await f.settle(m.messageId);
    const after = await f.projection({ threadId: c.threadId });
    if (after._tag !== "Success") throw new Error("No projection");
    expect(after.value.thread.agentsTaskCreation).toEqual(
      facts.projection.thread.agentsTaskCreation,
    );
    expect(after.value.thread.agentsTaskCreation!.review.effectiveInstructions).toBe(initial);
    expect(after.value.thread.taskContract).toEqual(facts.review.contract);
    expect((await f.inspect()).inputs).toEqual([initial, m.text]);
  });
}, 30000);
it("spent provider-start budget cannot be expanded by a result-continuation marker", async () => {
  await withTaskTransportFixture(async (f) => {
    const draft = creation("budget");
    const c = await completed(f, "budget", "Only admitted first turn", {
      ...draft,
      taskContract: {
        ...draft.taskContract!,
        brake: { ...draft.taskContract!.brake, maxProviderStarts: 1 },
      },
    });
    const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
    const reviewed = await f.review({
      environmentId: "environment-a",
      taskId: task.id,
      projectId: c.projectId,
      threadId: c.threadId,
      revision: 1,
    });
    const projected = await f.projection({ threadId: c.threadId });
    if (
      reviewed._tag !== "Success" ||
      reviewed.value.status !== "available" ||
      projected._tag !== "Success"
    )
      throw new Error("Missing actual budget facts");
    const run = projected.value.runs[0]!;
    const item = projected.value.turnItems.find((i) => i.type === "assistant_message")!;
    if (item.type !== "assistant_message") throw new Error("No actual output");
    const attempt = projected.value.attempts.find((a) => a.id === run.activeAttemptId)!;
    const m: TaskResultContinuation = {
      commandId: CommandId.make("budget-continuation"),
      messageId: MessageId.make("budget-continuation"),
      threadId: c.threadId,
      reference: reviewed.value.reference,
      contract: reviewed.value.contract,
      text: "No additional budget was granted",
      routingMode: "manual",
      modelSelection: c.modelSelection,
      runtimeMode: c.runtimeMode,
      interactionMode: c.interactionMode,
      priorResult: {
        runId: run.id,
        messageId: run.userMessageId!,
        attemptId: attempt.id,
        providerThreadId: run.providerThreadId!,
        providerTurnId: attempt.providerTurnId!,
        itemId: item.id,
        rootNodeId: run.rootNodeId!,
        nodeId: item.nodeId!,
        outputSha256: digestCanonical(item.text),
      },
    };
    expect((await send(f, m, m))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(1);
    expect((await f.snapshot()).tasks[0]!.budgetReadout).toMatchObject({
      status: "available",
      declaredStarts: 1,
      reservedStarts: 1,
    });
  });
}, 30000);

it("continuation cannot expand the reviewed contract or combine first-launch authority", async () => {
  await withTaskTransportFixture(async (f) => {
    const c = await completed(f, "forged-contract");
    const { m } = await continuation(f, c, "forged-contract");
    const expanded = {
      ...m,
      contract: {
        ...m.contract,
        brake: { ...m.contract.brake, maxProviderStarts: m.contract.brake.maxProviderStarts + 100 },
      },
    };
    expect((await send(f, expanded, expanded))._tag).toBe("Failure");
    const dual = {
      ...m,
      commandId: CommandId.make("dual-marker"),
      messageId: MessageId.make("dual-marker"),
    };
    const both: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
      type: "message.dispatch",
      commandId: dual.commandId,
      threadId: dual.threadId,
      messageId: dual.messageId,
      text: m.text,
      attachments: [],
      modelSelection: m.modelSelection,
      routingMode: m.routingMode,
      taskFirstLaunch: dual,
      taskResultContinuation: dual,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    };
    expect((await f.dispatch(both))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(1);
    expect((await f.snapshot()).tasks[0]!.contractReadout).toMatchObject({
      status: "available",
      contract: m.contract,
    });
  });
}, 30000);
