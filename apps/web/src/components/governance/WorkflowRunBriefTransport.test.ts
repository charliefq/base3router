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
const brief =
  "  原始要求 e\u0301 😀\r\nRetain requirement ONLY_IN_RUN_BRIEF even when artifacts omit it.  ";
function value<A>(result: { _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown }): A {
  if (result._tag !== "Success") throw new Error(String(result.cause));
  return result.value;
}
const contract = () => ({
  goal: "Current workflow stage",
  redirect: "Only explicit reviewed stage",
  acceptance: "Actual output and separate human decision",
  brake: {
    maxProviderStarts: 1,
    maxTokens: 4000,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    stopConditions: "No automatic successor",
  },
});
it("preserves one exact brief across Architecture, human gate revision, Implementation and Review, then isolates a new run", async () => {
  await withTaskTransportFixture(async (f) => {
    const catalog = value(await f.catalog({ projectId }));
    expect(catalog.runBriefVersion).toBe(1);
    const source = catalog.templates.find((t) => t.id === "saas-production")!;
    const stages = [
      source.stages[2]!,
      { ...source.stages[1]!, id: "owner_gate" },
      source.stages[3]!,
      source.stages[4]!,
    ].map((s, i, all) => ({ ...s, nextStageId: all[i + 1]?.id ?? null }));
    const saved = value(
      await f.workflowAction({
        type: "template.save",
        projectId,
        commandId: "brief-template",
        expectedVersion: 0,
        draft: {
          id: "brief-workflow",
          displayName: "Brief workflow",
          description: "Supervised delivery",
          stages,
        },
      }),
    );
    const immutableTemplate = JSON.stringify(
      saved.templates.find((t) => t.id === "brief-workflow"),
    );
    const create = {
      type: "run.start",
      projectId,
      commandId: "brief-create-a",
      runId: "brief-run-a",
      templateId: "brief-workflow",
      templateVersion: 1,
      originatingThreadId: null,
      originatingMessageId: null,
      brief,
    } as const;
    value(await f.workflowAction(create));
    value(await f.workflowAction(create));
    expect(value(await f.workflowTemplateStatus(create))).toBe("committed");
    expect(value(await f.workflowTemplateStatus({ ...create, brief: brief + " changed" }))).toBe(
      "conflict",
    );
    expect((await f.workflowAction({ ...create, brief: brief + " changed" }))._tag).toBe("Failure");
    expect((await f.inspect()).starts).toHaveLength(0);
    const act = async (
      input: Omit<
        Extract<WorkflowActionInput, { type: "decision.record" }>,
        "projectId" | "runId" | "type"
      >,
    ) =>
      value(
        await f.workflowAction({
          ...input,
          type: "decision.record",
          projectId,
          runId: create.runId,
        }),
      );
    const read = async () => value(await f.workflowRun({ projectId, runId: create.runId }))!;
    let starts = 0;
    const execute = async (stage: (typeof stages)[number], attempt: number) => {
      const before = await f.routingEvidenceState();
      const preview = value(
        await f.workflowPreview({
          environmentId,
          projectId,
          runId: create.runId,
          preferredRoute: target,
          taskContract: contract(),
          additionalInstruction: "Reviewed stage instruction",
        }),
      );
      expect(preview.packetText).toContain(`## Run brief (user-owned task context)\n`);
      expect(preview.packetText).toContain(brief);
      expect((await read()).brief).toBe(brief);
      expect(await f.routingEvidenceState()).toEqual(before);
      expect((await f.inspect()).starts).toHaveLength(starts);
      f.setWorkflowOutput(
        stage.requiredOutputSections
          .map((h) => `# ${h}\nActual fixture output deliberately omits initial requirements.`)
          .join("\n\n"),
      );
      const dispatched = value(
        await f.workflowDispatch({
          environmentId,
          projectId,
          runId: create.runId,
          stageId: stage.id,
          attempt,
          dispatchId: `brief-${stage.id}-${attempt}`,
          target,
          additionalInstruction: "Reviewed stage instruction",
          review: preview.review!,
        }),
      );
      await f.settle(dispatched.messageId);
      starts++;
      const inspected = await f.inspect();
      expect(inspected.starts).toHaveLength(starts);
      expect(inspected.inputs.at(-1)).toBe(
        `${preview.packetText}\n\n## User instruction\nReviewed stage instruction`,
      );
      const artifact = value(
        await f.workflowPropose({
          projectId,
          runId: create.runId,
          commandId: `brief-propose-${stage.id}-${attempt}`,
          artifactId: `brief-artifact-${stage.id}-${attempt}`,
        }),
      );
      expect(artifact.sections.map((s) => s.content).join("\n")).not.toContain("ONLY_IN_RUN_BRIEF");
      expect((await read()).brief).toBe(brief);
      return artifact;
    };
    const first = await execute(stages[0]!, 1);
    await act({
      commandId: "brief-approve-a1",
      decisionId: "brief-decision-a1",
      stageId: stages[0]!.id,
      attempt: 1,
      artifactId: first.id,
      value: "approve",
    });
    expect((await read()).currentStageId).toBe("owner_gate");
    expect((await f.inspect()).starts).toHaveLength(1);
    const feedback = {
      text: "Keep original requirements; revise architecture constraint separately.",
      source: { runId: create.runId, stageId: stages[0]!.id, attempt: 1, artifactId: first.id },
    };
    await act({
      commandId: "brief-revise",
      decisionId: "brief-revision",
      stageId: "owner_gate",
      attempt: 1,
      artifactId: null,
      value: "request_revision",
      revisionFeedback: feedback,
    });
    await f.disconnect();
    await f.connect();
    const revision = value(
      await f.workflowPreview({
        environmentId,
        projectId,
        runId: create.runId,
        preferredRoute: target,
        taskContract: contract(),
      }),
    );
    expect(revision.packetText).toContain(brief);
    expect(revision.packetText).toContain(feedback.text);
    expect((await read()).decisions.at(-1)?.revisionFeedback).toEqual(feedback);
    const second = await execute(stages[0]!, 2);
    await act({
      commandId: "brief-approve-a2",
      decisionId: "brief-decision-a2",
      stageId: stages[0]!.id,
      attempt: 2,
      artifactId: second.id,
      value: "approve",
    });
    await act({
      commandId: "brief-approve-gate",
      decisionId: "brief-decision-gate",
      stageId: "owner_gate",
      attempt: 2,
      artifactId: null,
      value: "approve",
    });
    value(
      await f.workflowAction({
        type: "run.pause",
        projectId,
        commandId: "brief-pause",
        runId: create.runId,
      }),
    );
    expect((await read()).brief).toBe(brief);
    await f.disconnect();
    await f.connect();
    value(
      await f.workflowAction({
        type: "run.resume",
        projectId,
        commandId: "brief-resume",
        runId: create.runId,
      }),
    );
    for (const stage of stages.slice(2)) {
      const artifact = await execute(stage, 1);
      await act({
        commandId: `brief-approve-${stage.id}`,
        decisionId: `brief-decision-${stage.id}`,
        stageId: stage.id,
        attempt: 1,
        artifactId: artifact.id,
        value: "approve",
      });
    }
    const terminal = await read();
    expect(terminal.status).toBe("completed");
    expect(terminal.brief).toBe(brief);
    const briefB = "Run B only — independent requirements.";
    value(
      await f.workflowAction({
        ...create,
        commandId: "brief-create-b",
        runId: "brief-run-b",
        brief: briefB,
      }),
    );
    const b = value(
      await f.workflowPreview({
        environmentId,
        projectId,
        runId: "brief-run-b",
        preferredRoute: target,
        taskContract: contract(),
      }),
    );
    expect(b.packetText).toContain(briefB);
    expect(b.packetText).not.toContain(brief);
    expect(await read()).toEqual(terminal);
    expect(
      JSON.stringify(
        value(await f.catalog({ projectId })).templates.find((t) => t.id === "brief-workflow"),
      ),
    ).toBe(immutableTemplate);
    expect((await f.inspect()).starts).toHaveLength(starts);
    value(
      await f.workflowAction({
        type: "run.cancel",
        projectId,
        commandId: "brief-cancel-b",
        runId: "brief-run-b",
      }),
    );
    expect(value(await f.workflowRun({ projectId, runId: "brief-run-b" }))?.brief).toBe(briefB);
  });
});
it.each(["", " ", "x".repeat(2001), "bad\ud800", "bad\u0000"])(
  "rejects invalid brief at authenticated ingress with zero writes/starts: %j",
  async (brief) => {
    await withTaskTransportFixture(async (f) => {
      const before = await f.routingEvidenceState();
      expect(
        (
          await f.workflowAction({
            type: "run.start",
            projectId,
            commandId: "invalid-brief",
            runId: "invalid-brief",
            templateId: "saas-production",
            templateVersion: 1,
            originatingThreadId: null,
            originatingMessageId: null,
            brief,
          })
        )._tag,
      ).toBe("Failure");
      expect(await f.routingEvidenceState()).toEqual(before);
      expect(value(await f.catalog({ projectId })).runs).toHaveLength(0);
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
);
