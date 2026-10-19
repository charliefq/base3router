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
