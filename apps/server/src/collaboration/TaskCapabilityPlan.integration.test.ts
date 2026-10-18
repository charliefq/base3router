import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, TaskCapabilityPlan, type ServerProvider } from "@t3tools/contracts";
import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  agentsCreationCommand,
  agentsCreationProvider,
} from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const samePlan = Schema.toEquivalence(TaskCapabilityPlan);
const contract = {
  goal: "Fix parser",
  redirect: "Keep fixture scope",
  acceptance: "Parser regression passes",
  brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
};
const skill = {
  name: "parser-tests",
  path: "/fixture/parser/SKILL.md",
  description: "Parser regression tests",
  enabled: true,
};
function reviewed(workspace: string, key: string, provider: ServerProvider) {
  const c = { ...agentsCreationCommand(key), taskContract: contract };
  return {
    ...c,
    taskCreationReview: {
      ...c.taskCreationReview!,
      capabilityPlan: planTaskCapabilities({
        environmentId: "environment-a",
        projectId: c.projectId,
        workspace,
        modelSelection: c.modelSelection,
        contract,
        provider,
      }),
    },
  };
}
const nativeProvider = (workspace: string): ServerProvider => ({
  ...agentsCreationProvider,
  skills: [skill],
  workspaceSnapshots: [
    {
      cwd: workspace,
      checkedAt: agentsCreationProvider.checkedAt,
      skills: [skill],
      slashCommands: [],
    },
  ],
});

it.live.each(["current", "disabled", "removed", "unknown workspace", "edited contract"] as const)(
  "review-only capability lifecycle persists %s evidence without invoking skills",
  (change) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const roots = yield* f.sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id='project-a'`;
          const workspace = roots[0]!.workspace_root;
          const provider = nativeProvider(workspace);
          f.setProviders([provider]);
          const c = reviewed(workspace, "capability-task", provider);
          assert.equal(
            c.taskCreationReview.capabilityPlan.entries.filter((e) => e.selected).length,
            1,
          );
          yield* f.dispatch(c);
          const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
          const review = yield* f.readReview({
            environmentId: "environment-a",
            projectId: c.projectId,
            threadId: c.threadId,
            taskId: task.id,
            revision: 1,
          });
          assert.equal(review.status, "available");
          if (review.status !== "available") throw new Error("Missing review");
          assert.equal(review.capabilityEvidence?.status, "current");
          assert.deepEqual(yield* f.sql`SELECT * FROM task_contract_admissions`, []);
          assert.deepEqual(yield* f.sql`SELECT * FROM base3_execution_grants`, []);

          if (change === "disabled")
            f.setProviders([
              {
                ...provider,
                workspaceSnapshots: [
                  { ...provider.workspaceSnapshots![0]!, skills: [{ ...skill, enabled: false }] },
                ],
              },
            ]);
          if (change === "removed")
            f.setProviders([
              {
                ...provider,
                workspaceSnapshots: [{ ...provider.workspaceSnapshots![0]!, skills: [] }],
              },
            ]);
          if (change === "unknown workspace")
            f.setProviders([{ ...provider, workspaceSnapshots: [] }]);
          if (change === "edited contract")
            yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.taskContract.goal','Changed task') WHERE thread_id=${c.threadId}`;
          const key = "capability-message";
          yield* f.execute(c, key);
          const result = (yield* f.readSnapshot()).tasks.find(
            (t) => t.threadId === c.threadId,
          )!.resultReadout;
          assert.equal(result?.status, "available");
          if (result?.status !== "available") throw new Error("Missing persisted result");
          assert.equal(
            result.capabilityEvidence?.status,
            change === "current" ? "current" : "stale",
            result.capabilityEvidence?.reason,
          );
          assert.isTrue(
            samePlan(result.capabilityEvidence!.reviewed, c.taskCreationReview.capabilityPlan),
          );
          if (change === "current") yield* f.dispatch(c);
          const executions = yield* Ref.get(f.executions);
          assert.equal(executions.length, 1);
          assert.equal(
            executions[0]!.message.text,
            key,
            "No skill mention/instructions appended to provider message",
          );
          assert.isUndefined(
            (executions[0]!.runtimePolicy as { tools?: unknown }).tools,
            "No MCP grant/allowlist injected",
          );
          assert.equal(executions[0]!.runtimePolicy.runtimeMode, "approval-required");
          const grants = yield* f.sql<{
            operation: string;
          }>`SELECT operation FROM base3_execution_grants WHERE thread_id=${c.threadId}`;
          assert.isTrue(
            grants.every((g) => g.operation === "message" || g.operation === "usage-limit"),
            "No skill/MCP execution grant added",
          );
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId: c.threadId,
            messageId: MessageId.make(key),
            text: key,
            attachments: [],
            routingMode: "auto",
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 1);
          yield* f.rebuild;
          const refreshed = (yield* f.readSnapshot()).tasks.find(
            (t) => t.threadId === c.threadId,
          )!.resultReadout;
          assert.deepEqual(refreshed, result);
        }),
      { governedWorker: true },
    ),
);

it.live.each(["tampered", "stale"] as const)(
  "creation refuses %s reviewed capability inventory without side effects",
  (change) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const roots = yield* f.sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id='project-a'`;
          const provider = nativeProvider(roots[0]!.workspace_root);
          f.setProviders([provider]);
          const c = reviewed(roots[0]!.workspace_root, "capability-denied", provider);
          const command =
            change === "tampered"
              ? {
                  ...c,
                  taskCreationReview: {
                    ...c.taskCreationReview,
                    capabilityPlan: {
                      ...c.taskCreationReview.capabilityPlan,
                      entries: [
                        {
                          ...c.taskCreationReview.capabilityPlan.entries[0]!,
                          id: "arbitrary/evil",
                          selected: true,
                        },
                      ],
                    },
                  },
                }
              : c;
          if (change === "stale") f.setProviders([{ ...provider, workspaceSnapshots: [] }]);
          assert.isTrue(Exit.isFailure(yield* f.dispatch(command).pipe(Effect.exit)));
          assert.equal((yield* Ref.get(f.started)).length, 0);
          assert.deepEqual(yield* f.sql`SELECT * FROM task_contract_admissions`, []);
          assert.deepEqual(
            yield* f.sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${c.threadId}`,
            [],
          );
        }),
      { governedWorker: true },
    ),
);

it.live(
  "stopped deferred task keeps review-only evidence across replay without starting a provider",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const roots = yield* f.sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id='project-a'`;
          const provider = nativeProvider(roots[0]!.workspace_root);
          f.setProviders([provider]);
          const c = reviewed(roots[0]!.workspace_root, "capability-cancel", provider);
          yield* f.dispatch(c);
          yield* f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("defer"),
            threadId: c.threadId,
            messageId: MessageId.make("defer"),
            text: "Deferred",
            attachments: [],
            routingMode: "auto",
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
          });
          const run = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
          assert.equal(run.capabilityEvidence?.status, "current");
          yield* f.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId: c.threadId,
            runId: run.id,
          });
          yield* f.worker.drain();
          yield* f.rebuild;
          const after = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
          assert.equal(after.capabilityEvidence?.status, "current");
          assert.equal(after.status, "interrupted");
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      { governedWorker: true },
    ),
);
