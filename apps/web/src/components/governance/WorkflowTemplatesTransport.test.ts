import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type WorkflowActionInput,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "../collaboration/testkit/taskCreationTransportFixture";
const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const target = { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" };
function success<A>(
  result: { _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown },
): A {
  if (result._tag !== "Success") throw new Error(String(result.cause));
  return result.value;
}
const contract = {
  goal: "Compose supervised delivery",
  redirect: "Only the current stage",
  acceptance: "Human reviews actual artifact",
  brake: {
    maxProviderStarts: 1,
    maxTokens: 4000,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    stopConditions: "No automatic successor",
  },
};
it("saves immutable versions and executes Architecture → Implementation → Review with actual native artifacts and explicit starts", async () => {
  await withTaskTransportFixture(async (f) => {
    const catalog = success(await f.catalog({ projectId }));
    expect(catalog.reusableTemplatesVersion).toBe(1);
    const source = catalog.templates.find((t) => t.id === "saas-production")!;
    const stages = source.stages.slice(2, 5).map((s, index, all) => ({
      ...s,
      nextStageId: all[index + 1]?.id ?? null,
      taskPromptTemplate: `Version one stage ${s.id}: perform the bounded reviewed work.`,
    }));
    const save: WorkflowActionInput = {
      type: "template.save",
      projectId,
      commandId: "composition-save-v1",
      expectedVersion: 0,
      draft: {
        id: "delivery-workflow",
        displayName: "Delivery workflow",
        description: "Architecture then implementation and review",
        stages,
      },
    };
    expect(success(await f.workflowTemplateStatus(save))).toBe("unknown");
    const first = success(await f.workflowAction(save));
    expect(first.templates.find((t) => t.id === "delivery-workflow")?.version).toBe(1);
    await f.disconnect();
    await f.connect();
    expect(success(await f.workflowTemplateStatus(save))).toBe("committed");
    success(await f.workflowAction(save));
    expect(
      success(
        await f.workflowTemplateStatus({
          ...save,
          draft: { ...save.draft, displayName: "Conflicting same command" },
        }),
      ),
    ).toBe("conflict");
    expect(
      (
        await f.workflowAction({
          ...save,
          draft: { ...save.draft, displayName: "Conflicting same command" },
        })
      )._tag,
    ).toBe("Failure");
    const create: WorkflowActionInput = {
      type: "run.start",
      projectId,
      commandId: "composition-create-v1",
      runId: "composition-run-v1",
      templateId: save.draft.id,
      templateVersion: 1,
      originatingThreadId: null,
      originatingMessageId: null,
    };
    success(await f.workflowAction(create));
    success(await f.workflowAction(create));
    expect(success(await f.workflowTemplateStatus(create))).toBe("committed");
    expect((await f.inspect()).starts).toHaveLength(0);
    const role = catalog.profiles.find((p) => p.id === "implementer" && p.version === 1)!;
    const v2: WorkflowActionInput = {
      ...save,
      commandId: "composition-save-v2",
      expectedVersion: 1,
      draft: {
        ...save.draft,
        stages: save.draft.stages.map((s, i) =>
          i === 0
            ? {
                ...s,
                profileId: role.id,
                profileVersion: role.version,
                artifactKind: role.artifactKind,
                requiredOutputSections: role.requiredOutputSections,
                capabilityPreferences: role.capabilityPreferences,
                taskPromptTemplate: "Version two changed role and instructions",
              }
            : s,
        ),
      },
    };
    const saved2 = success(await f.workflowAction(v2));
    expect(saved2.templates.filter((t) => t.id === save.draft.id).map((t) => t.version)).toEqual([
      1, 2,
    ]);
    expect((await f.workflowAction({ ...v2, commandId: "stale-version-save" }))._tag).toBe(
      "Failure",
    );
    expect(
      (
        await f.workflowAction({
          ...create,
          commandId: "parallel-create",
          runId: "parallel-run",
          templateVersion: 2,
        })
      )._tag,
    ).toBe("Failure");
    await f.disconnect();
    await f.connect();
    expect(success(await f.workflowRun({ projectId, runId: create.runId }))?.templateVersion).toBe(
      1,
    );
    for (const [index, stage] of stages.entries()) {
      const count = (await f.inspect()).starts.length;
      const preview = success(
        await f.workflowPreview({
          environmentId,
          projectId,
          runId: create.runId,
          preferredRoute: target,
          taskContract: contract,
        }),
      );
      expect(preview.packetText).toContain(stage.taskPromptTemplate);
      expect(preview.packetText).not.toContain("Version two changed");
      expect(preview.route.selected?.target).toEqual(target);
      expect(preview.review).toBeTruthy();
      expect((await f.inspect()).starts).toHaveLength(count);
      f.setWorkflowOutput(
        stage.requiredOutputSections
          .map((h) => `# ${h}\nFixture actual ${stage.id} output for ${h}.`)
          .join("\n\n"),
      );
      const dispatched = success(
        await f.workflowDispatch({
          environmentId,
          projectId,
          runId: create.runId,
          stageId: stage.id,
          attempt: 1,
          dispatchId: `composition-stage-${index}`,
          target,
          additionalInstruction: "",
          review: preview.review!,
        }),
      );
      await f.settle(dispatched.messageId);
      const actual = await f.inspect();
      expect(actual.starts).toHaveLength(count + 1);
      expect(actual.inputs.at(-1)).toContain(stage.taskPromptTemplate);
      const artifact = success(
        await f.workflowPropose({
          projectId,
          runId: create.runId,
          artifactId: `composition-artifact-${index}`,
          commandId: `composition-propose-${index}`,
        }),
      );
      expect(artifact.sourceOutcome).toBe("completed");
      expect(artifact.profileId).toBe(stage.profileId);
      expect(artifact.profileVersion).toBe(stage.profileVersion);
      expect(artifact.missingSections).toEqual([]);
      const native = success(await f.projection({ threadId: dispatched.threadId }));
      expect(
        native.messages.some(
          (m) => m.id === artifact.outputMessageId && m.runId === artifact.sourceTurnId,
        ) ||
          native.turnItems.some(
            (item) => item.id === artifact.sourceItemId && item.runId === artifact.sourceTurnId,
          ),
      ).toBe(true);
      const approved = success(
        await f.workflowAction({
          type: "decision.record",
          projectId,
          commandId: `composition-approve-${index}`,
          decisionId: `composition-decision-${index}`,
          runId: create.runId,
          stageId: stage.id,
          attempt: 1,
          artifactId: artifact.id,
          value: "approve",
        }),
      );
      expect(approved.runs.find((r) => r.id === create.runId)?.status).toBe(
        index === 2 ? "completed" : "active",
      );
      expect((await f.inspect()).starts).toHaveLength(count + 1);
    }
    const latest = success(await f.catalog({ projectId }));
    expect(latest.templates.find((t) => t.id === save.draft.id && t.version === 1)?.stages).toEqual(
      stages,
    );
    success(
      await f.workflowAction({
        ...create,
        commandId: "composition-create-v2",
        runId: "composition-run-v2",
        templateVersion: 2,
      }),
    );
    const preview2 = success(
      await f.workflowPreview({
        environmentId,
        projectId,
        runId: "composition-run-v2",
        preferredRoute: target,
        taskContract: contract,
      }),
    );
    expect(preview2.packetText).toContain("Version two changed role and instructions");
    expect(preview2.packetText).toContain("Role: Implementer v1");
    expect((await f.inspect()).starts).toHaveLength(3);
    f.setWorkflowOutput(
      role.requiredOutputSections.map((h) => `# ${h}\nVersion two actual output.`).join("\n\n"),
    );
    const v2start = success(
      await f.workflowDispatch({
        environmentId,
        projectId,
        runId: "composition-run-v2",
        stageId: stages[0]!.id,
        attempt: 1,
        dispatchId: "composition-v2-explicit",
        target,
        additionalInstruction: "",
        review: preview2.review!,
      }),
    );
    await f.settle(v2start.messageId);
    expect((await f.inspect()).inputs.at(-1)).toContain(
      "Version two changed role and instructions",
    );
    const v2artifact = success(
      await f.workflowPropose({
        projectId,
        runId: "composition-run-v2",
        artifactId: "composition-v2-artifact",
        commandId: "composition-v2-propose",
      }),
    );
    expect(v2artifact.profileId).toBe(role.id);
    expect(v2artifact.sourceOutcome).toBe("completed");
    expect(v2artifact.missingSections).toEqual([]);
    await f.disconnect();
    await f.connect(["orchestration:read"]);
    expect((await f.workflowTemplateStatus(save))._tag).toBe("Failure");
    expect((await f.workflowAction({ ...save, commandId: "readonly-save" }))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(4);
  });
});

it.each(["template.save", "run.start"] as const)(
  "reconciles a lost committed %s response by original identity without resending",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const catalog = success(await f.catalog({ projectId }));
      const s = catalog.templates[0]!.stages[2]!;
      const save: Extract<WorkflowActionInput, { type: "template.save" }> = {
        type: "template.save",
        projectId,
        commandId: "lost-template-save",
        expectedVersion: 0,
        draft: {
          id: "lost-workflow",
          displayName: "Lost reply fixture",
          description: "Original identity only",
          stages: [{ ...s, nextStageId: null }],
        },
      };
      const create: Extract<WorkflowActionInput, { type: "run.start" }> = {
        type: "run.start",
        projectId,
        commandId: "lost-template-run",
        runId: "lost-workflow-run",
        brief: "  Original lost-reply brief 😀\r\nNo resend.  ",
        templateId: save.draft.id,
        templateVersion: 1,
        originatingThreadId: null,
        originatingMessageId: null,
      };
      if (kind === "run.start") success(await f.workflowAction(save));
      const original = kind === "template.save" ? save : create;
      f.dropNextReply();
      const pending = f.workflowAction(original);
      await Promise.race([
        f.awaitDroppedReply(),
        pending.then(() => {
          throw new Error("Reply was not dropped");
        }),
      ]);
      await f.disconnect();
      await pending;
      await f.connect();
      const before = success(await f.catalog({ projectId }));
      expect(success(await f.workflowTemplateStatus(original))).toBe("committed");
      expect(
        success(await f.workflowTemplateStatus({ ...original, commandId: "never-sent-original" })),
      ).toBe("unknown");
      expect(success(await f.catalog({ projectId }))).toEqual(before);
      expect((await f.inspect()).starts).toHaveLength(0);
      if (original.type === "template.save")
        expect(before.templates.filter((t) => t.id === original.draft.id)).toHaveLength(1);
      else {
        expect(before.runs.filter((r) => r.id === original.runId)).toHaveLength(1);
        expect(before.runs.find((r) => r.id === original.runId)?.brief).toBe(original.brief);
        expect(
          success(
            await f.workflowTemplateStatus({ ...original, brief: original.brief + " changed" }),
          ),
        ).toBe("conflict");
      }
      expect(
        (
          await f.workflowTemplateStatus({
            type: "run.cancel",
            projectId,
            commandId: "unsupported-status",
            runId: create.runId,
          })
        )._tag,
      ).toBe("Failure");
    });
  },
);

it("retains exact human-gate revision feedback in a custom composed workflow", async () => {
  await withTaskTransportFixture(async (f) => {
    const catalog = success(await f.catalog({ projectId }));
    const source = catalog.templates[0]!;
    const first = { ...source.stages[2]!, nextStageId: "owner_gate" };
    const gate = { ...source.stages[1]!, id: "owner_gate", nextStageId: null };
    success(
      await f.workflowAction({
        type: "template.save",
        projectId,
        commandId: "gate-template-save",
        expectedVersion: 0,
        draft: {
          id: "gate-workflow",
          displayName: "Gate workflow",
          description: "Exact preceding occurrence",
          stages: [first, gate],
        },
      }),
    );
    success(
      await f.workflowAction({
        type: "run.start",
        projectId,
        commandId: "gate-workflow-create",
        runId: "gate-workflow-run",
        templateId: "gate-workflow",
        templateVersion: 1,
        originatingThreadId: null,
        originatingMessageId: null,
      }),
    );
    const preview = success(
      await f.workflowPreview({
        environmentId,
        projectId,
        runId: "gate-workflow-run",
        preferredRoute: target,
        taskContract: contract,
      }),
    );
    f.setWorkflowOutput(
      first.requiredOutputSections
        .map((h) => `# ${h}\nActual architecture fixture evidence.`)
        .join("\n\n"),
    );
    const start = success(
      await f.workflowDispatch({
        environmentId,
        projectId,
        runId: "gate-workflow-run",
        stageId: first.id,
        attempt: 1,
        dispatchId: "gate-first-start",
        target,
        additionalInstruction: "",
        review: preview.review!,
      }),
    );
    await f.settle(start.messageId);
    const artifact = success(
      await f.workflowPropose({
        projectId,
        runId: "gate-workflow-run",
        artifactId: "gate-actual-artifact",
        commandId: "gate-propose",
      }),
    );
    success(
      await f.workflowAction({
        type: "decision.record",
        projectId,
        commandId: "gate-approve-first",
        decisionId: "gate-first-decision",
        runId: "gate-workflow-run",
        stageId: first.id,
        attempt: 1,
        artifactId: artifact.id,
        value: "approve",
      }),
    );
    const feedback = {
      text: "Revise only the disputed architecture constraint.",
      source: {
        runId: "gate-workflow-run",
        stageId: first.id,
        attempt: 1,
        artifactId: artifact.id,
      },
    };
    success(
      await f.workflowAction({
        type: "decision.record",
        projectId,
        commandId: "gate-request-revision",
        decisionId: "gate-revision",
        runId: "gate-workflow-run",
        stageId: gate.id,
        attempt: 1,
        artifactId: null,
        value: "request_revision",
        revisionFeedback: feedback,
      }),
    );
    await f.disconnect();
    await f.connect();
    const next = success(
      await f.workflowPreview({
        environmentId,
        projectId,
        runId: "gate-workflow-run",
        preferredRoute: target,
        taskContract: contract,
      }),
    );
    expect(next.packetText).toContain(feedback.text);
    expect(next.packetText).toContain(artifact.id);
    expect(next.packetText).toContain("Attempt 1");
    expect((await f.inspect()).starts).toHaveLength(1);
  });
});
