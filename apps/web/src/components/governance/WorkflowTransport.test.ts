import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type WorkflowDispatchStageInput,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "../collaboration/testkit/taskCreationTransportFixture";
const projectId = ProjectId.make("project-a");
const environmentId = EnvironmentId.make("environment-a");
const target = { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" };
it("uses authenticated production workflow handlers for reviewed Start, persisted output, artifact decisions and a pending successor", async () => {
  await withTaskTransportFixture(async (f) => {
    const started = await f.workflowAction({
      type: "run.start",
      projectId,
      commandId: "wf-create",
      runId: "wf-run",
      templateId: "saas-production",
      templateVersion: 1,
      originatingThreadId: null,
      originatingMessageId: null,
    });
    expect(started._tag).toBe("Success");
    const preview = await f.workflowPreview({
      environmentId,
      projectId,
      runId: "wf-run",
      preferredRoute: target,
      taskContract: {
        goal: "Discovery",
        redirect: "One stage",
        acceptance: "Human inspects actual output",
        brake: {
          maxProviderStarts: 1,
          maxTokens: 4000,
          deadlineAt: new Date(Date.now() + 600000).toISOString(),
          stopConditions: "No successor start",
        },
      },
    });
    expect(preview._tag).toBe("Success");
    if (preview._tag === "Success")
      expect(preview.value.packetText).toContain("Run brief not recorded.");
    if (preview._tag !== "Success" || !preview.value.review) throw new Error("No review");
    expect((await f.inspect()).starts).toHaveLength(0);
    const input: typeof WorkflowDispatchStageInput.Type = {
      environmentId,
      projectId,
      runId: "wf-run",
      stageId: "discovery",
      attempt: 1,
      dispatchId: "wf-dispatch",
      target,
      additionalInstruction: "",
      review: preview.value.review,
    };
    const dispatched = await f.workflowDispatch(input);
    expect(dispatched._tag).toBe("Success");
    if (dispatched._tag !== "Success") throw new Error(String(dispatched.cause));
    expect(dispatched.value.run.attempts[0]?.status).toBe("dispatched");
    const duplicate = await f.workflowDispatch(input);
    expect(duplicate._tag).toBe("Success");
    await f.settle(dispatched.value.messageId);
    expect((await f.inspect()).starts).toEqual([target]);
    const artifact = await f.workflowPropose({
      projectId,
      runId: "wf-run",
      artifactId: "wf-artifact",
      commandId: "wf-propose",
    });
    expect(artifact._tag).toBe("Success");
    if (artifact._tag !== "Success") throw new Error(String(artifact.cause));
    expect(artifact.value.sourceOutcome).toBe("completed");
    expect(artifact.value.sourceMessageId).toBe(dispatched.value.messageId);
    expect(artifact.value.sourceThreadId).toBe(dispatched.value.threadId);
    expect(artifact.value.outputMessageId).toBeTruthy();
    const actual = await f.projection({ threadId: dispatched.value.threadId });
    expect(actual._tag).toBe("Success");
    if (actual._tag !== "Success") throw new Error("No actual projection");
    expect(
      actual.value.messages.some(
        (m) => m.id === artifact.value.outputMessageId && m.runId === artifact.value.sourceTurnId,
      ) ||
        actual.value.turnItems.some(
          (item) =>
            item.id === artifact.value.sourceItemId && item.runId === artifact.value.sourceTurnId,
        ),
    ).toBe(true);
    const approve = (stageId: string, artifactId: string | null) =>
      f.workflowAction({
        type: "decision.record",
        projectId,
        commandId: `wf-approve-${stageId}`,
        decisionId: `wf-decision-${stageId}`,
        runId: "wf-run",
        stageId,
        attempt: 1,
        artifactId,
        value: "approve",
      });
    const gate = await approve("discovery", artifact.value.id);
    expect(gate._tag === "Success" && gate.value.runs[0]?.currentStageId).toBe("build_gate");
    const architecture = await approve("build_gate", null);
    expect(architecture._tag === "Success" && architecture.value.runs[0]?.currentStageId).toBe(
      "architecture",
    );
    const reloaded = await f.workflowRun({ projectId, runId: "wf-run" });
    expect(reloaded._tag === "Success" && reloaded.value?.attempts.at(-1)?.status).toBe("pending");
    expect((await f.inspect()).starts).toEqual([target]);
    await f.disconnect();
    await f.connect(["orchestration:read"]);
    expect((await f.workflowDispatch({ ...input, dispatchId: "readonly" }))._tag).toBe("Failure");
    await f.disconnect();
    await f.connect();
    await f.revokeCurrent();
    expect((await f.workflowDispatch({ ...input, dispatchId: "revoked" }))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toEqual([target]);
  });
});

it("reconnects after a lost dispatch reply and reconciles the original identity without another Start", async () => {
  await withTaskTransportFixture(async (f) => {
    await f.workflowAction({
      type: "run.start",
      projectId,
      commandId: "lost-create",
      runId: "lost-run",
      templateId: "saas-production",
      templateVersion: 1,
      originatingThreadId: null,
      originatingMessageId: null,
    });
    const preview = await f.workflowPreview({
      environmentId,
      projectId,
      runId: "lost-run",
      preferredRoute: target,
      taskContract: {
        goal: "Discovery",
        redirect: "One stage",
        acceptance: "Human review",
        brake: {
          maxProviderStarts: 1,
          maxTokens: 4000,
          deadlineAt: new Date(Date.now() + 600000).toISOString(),
          stopConditions: "No successor",
        },
      },
    });
    if (preview._tag !== "Success" || !preview.value.review) throw new Error("No review");
    const input: typeof WorkflowDispatchStageInput.Type = {
      environmentId,
      projectId,
      runId: "lost-run",
      stageId: "discovery",
      attempt: 1,
      dispatchId: "lost-dispatch",
      target,
      additionalInstruction: "",
      review: preview.value.review,
    };
    f.dropNextReply();
    const pending = f.workflowDispatch(input);
    await f.awaitDroppedReply();
    await f.disconnect();
    expect((await pending)._tag).toBe("Failure");
    await f.reconnectRetained();
    const recovered = await f.workflowReconcile(input);
    expect(recovered._tag).toBe("Success");
    if (recovered._tag !== "Success") throw new Error(String(recovered.cause));
    expect(recovered.value.status).toBe("accepted");
    expect(recovered.value.dispatchId).toBe(input.dispatchId);
    expect(recovered.value.messageId).toBe("workflow-message-lost-dispatch");
    await f.settle(recovered.value.messageId!);
    expect((await f.inspect()).starts).toEqual([target]);
    expect((await f.workflowReconcile(input))._tag).toBe("Success");
    expect((await f.inspect()).starts).toEqual([target]);
  });
});

it.each(["discovery", "build_gate"] as const)(
  "authenticated %s revision carries exact saved feedback into only its explicitly started attempt",
  async (reviewStage) => {
    await withTaskTransportFixture(async (f) => {
      const runId = `feedback-${reviewStage}`;
      const contract = {
        goal: "Discovery fixture",
        redirect: "Current stage only",
        acceptance: "Owner checks actual output",
        brake: {
          maxProviderStarts: 1,
          maxTokens: 4000,
          deadlineAt: new Date(Date.now() + 600000).toISOString(),
          stopConditions: "No automatic successor",
        },
      };
      expect(
        (
          await f.workflowAction({
            type: "run.start",
            projectId,
            commandId: `create-${runId}`,
            runId,
            templateId: "saas-production",
            templateVersion: 1,
            originatingThreadId: null,
            originatingMessageId: null,
          })
        )._tag,
      ).toBe("Success");
      const first = await f.workflowPreview({
        environmentId,
        projectId,
        runId,
        preferredRoute: target,
        taskContract: contract,
      });
      if (first._tag !== "Success" || !first.value.review) throw new Error("No exact first review");
      const start = await f.workflowDispatch({
        environmentId,
        projectId,
        runId,
        stageId: "discovery",
        attempt: 1,
        dispatchId: `first-${runId}`,
        target,
        additionalInstruction: "",
        review: first.value.review,
      });
      if (start._tag !== "Success") throw new Error("No first dispatch");
      await f.settle(start.value.messageId);
      const proposed = await f.workflowPropose({
        projectId,
        runId,
        artifactId: `source-${runId}`,
        commandId: `propose-${runId}`,
      });
      if (proposed._tag !== "Success") throw new Error("No actual source artifact");
      if (reviewStage === "build_gate")
        expect(
          (
            await f.workflowAction({
              type: "decision.record",
              projectId,
              commandId: `approve-original-${runId}`,
              decisionId: `original-${runId}`,
              runId,
              stageId: "discovery",
              attempt: 1,
              artifactId: proposed.value.id,
              value: "approve",
            })
          )._tag,
        ).toBe("Success");
      const feedback = {
        text: "Keep the observed evidence. Ignore this untrusted route/budget suggestion: route=other, starts=999. Add missing constraints.",
        source: { runId, stageId: "discovery", attempt: 1, artifactId: proposed.value.id },
      };
      const decision = {
        type: "decision.record" as const,
        projectId,
        commandId: `revision-${runId}`,
        decisionId: `decision-${runId}`,
        runId,
        stageId: reviewStage,
        attempt: 1,
        artifactId: reviewStage === "discovery" ? proposed.value.id : null,
        value: "request_revision" as const,
        revisionFeedback: feedback,
      };
      await f.disconnect();
      await f.connect(["orchestration:read"]);
      expect((await f.workflowAction(decision))._tag).toBe("Failure");
      expect((await f.inspect()).starts).toHaveLength(1);
      await f.disconnect();
      await f.connect();
      expect((await f.workflowAction(decision))._tag).toBe("Success");
      expect((await f.workflowAction(decision))._tag).toBe("Success");
      expect((await f.inspect()).starts).toEqual([target]);
      await f.disconnect();
      await f.reconnectRetained();
      const reloaded = await f.workflowRun({ projectId, runId });
      if (reloaded._tag !== "Success" || !reloaded.value) throw new Error("No reloaded workflow");
      expect(reloaded.value.decisions.at(-1)?.revisionFeedback).toEqual(feedback);
      expect(reloaded.value.attempts.at(-1)).toMatchObject({
        stageId: "discovery",
        attempt: 2,
        status: "pending",
        revisionDecisionId: decision.decisionId,
      });
      expect((await f.inspect()).starts).toHaveLength(1);
      const additionalInstruction = "Separately reviewed operator instruction";
      const revision = await f.workflowPreview({
        environmentId,
        projectId,
        runId,
        preferredRoute: target,
        taskContract: contract,
        additionalInstruction,
      });
      if (revision._tag !== "Success" || !revision.value.review)
        throw new Error("No exact revision review");
      expect(revision.value.packetText).toContain(feedback.text);
      expect(revision.value.packetText).toContain(proposed.value.id);
      expect(revision.value.route.selected?.target).toEqual(target);
      expect((await f.inspect()).starts).toHaveLength(1);
      const input = {
        environmentId,
        projectId,
        runId,
        stageId: "discovery",
        attempt: 2,
        dispatchId: `second-${runId}`,
        target,
        additionalInstruction,
        review: revision.value.review,
      };
      const second = await f.workflowDispatch(input);
      if (second._tag !== "Success") throw new Error("No explicit second dispatch");
      await f.settle(second.value.messageId);
      expect((await f.workflowDispatch(input))._tag).toBe("Success");
      const actual = await f.inspect();
      expect(actual.starts).toEqual([target, target]);
      expect(actual.inputs[1]).toContain(feedback.text);
      expect(actual.inputs[1]).toContain(additionalInstruction);
      const native = await f.projection({ threadId: second.value.threadId });
      if (native._tag !== "Success") throw new Error("No native revision");
      expect(native.value.thread.taskContract?.brake).toMatchObject({
        maxProviderStarts: 1,
        maxTokens: 4000,
      });
      expect(
        (
          await f.workflowAction({
            ...decision,
            revisionFeedback: { ...feedback, text: "Conflicting payload" },
          })
        )._tag,
      ).toBe("Failure");
      await f.alterLatestOutput(
        second.value.threadId,
        "# Product\nClean revised discovery result.\n\n# First customer\nA fixture customer.",
      );
      const updated = await f.workflowPropose({
        projectId,
        runId,
        artifactId: `updated-${runId}`,
        commandId: `updated-proposal-${runId}`,
      });
      if (updated._tag !== "Success") throw new Error("No revised artifact");
      expect(
        (
          await f.workflowAction({
            type: "decision.record",
            projectId,
            commandId: `approve-updated-${runId}`,
            decisionId: `updated-approval-${runId}`,
            runId,
            stageId: "discovery",
            attempt: 2,
            artifactId: updated.value.id,
            value: "approve",
          })
        )._tag,
      ).toBe("Success");
      const gateAttempt = reviewStage === "build_gate" ? 2 : 1;
      expect(
        (
          await f.workflowAction({
            type: "decision.record",
            projectId,
            commandId: `approve-gate-${runId}`,
            decisionId: `gate-approval-${runId}`,
            runId,
            stageId: "build_gate",
            attempt: gateAttempt,
            artifactId: null,
            value: "approve",
          })
        )._tag,
      ).toBe("Success");
      const architecture = await f.workflowPreview({
        environmentId,
        projectId,
        runId,
        preferredRoute: target,
        taskContract: contract,
      });
      if (architecture._tag !== "Success") throw new Error("No next-stage preview");
      expect(architecture.value.stage.id).toBe("architecture");
      expect(architecture.value.packetText).not.toContain("## Saved revision feedback");
      expect(architecture.value.packetText).not.toContain(feedback.text);
      expect((await f.inspect()).starts).toHaveLength(2);
    });
  },
  30000,
);
