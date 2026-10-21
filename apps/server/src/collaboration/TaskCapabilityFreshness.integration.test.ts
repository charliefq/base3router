import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ServerProvider,
} from "@t3tools/contracts";
import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as DateTime from "effect/DateTime";
import {
  agentsCreationCommand,
  agentsCreationProvider,
} from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const skill = {
  name: "parser-tests",
  description: "Parser regression tests",
  path: "/fixture/parser/SKILL.md",
  enabled: true,
};
const contract = {
  goal: "Fix parser",
  redirect: "Ask before expanding",
  acceptance: "Parser tests pass",
  brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
};
// Existing kernel subject isolates replacement mechanics from the separate
// session capacity gate, which currently refuses a second foreground lease.
const kernel = {
  kind: "kernel-test" as const,
  actorId: "kernel-test" as const,
  scopes: ["orchestration:operate"] as const,
};
const send = (
  threadId: ReturnType<typeof agentsCreationCommand>["threadId"],
  key: string,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(key),
  threadId,
  messageId: MessageId.make(key),
  text: key,
  attachments: [],
  routingMode: "auto",
  dispatchMode,
  createdBy: "user",
  creationSource: "web",
});

it.live.each(["restart-disabled", "restart-removed", "steer", "queue"] as const)(
  "capability freshness survives held %s work and preserves attempt history",
  (mode) =>
    Effect.gen(function* () {
      let starts = 0;
      let finishFirst: () => Effect.Effect<void> = () => Effect.void;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const roots = yield* f.sql<{
              workspace_root: string;
            }>`SELECT workspace_root FROM projection_projects WHERE project_id='project-a'`;
            const workspace = roots[0]!.workspace_root;
            const provider: ServerProvider = {
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
            };
            f.setProviders([provider]);
            const base = { ...agentsCreationCommand(`fresh-${mode}`), taskContract: contract };
            const c = {
              ...base,
              taskCreationReview: {
                ...base.taskCreationReview!,
                capabilityPlan: planTaskCapabilities({
                  environmentId: "environment-a",
                  projectId: base.projectId,
                  workspace,
                  modelSelection: base.modelSelection,
                  contract,
                  provider,
                }),
              },
            };
            yield* f.dispatch(c);
            const running = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "provider-turn.updated" &&
                  e.threadId === c.threadId &&
                  e.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* f.dispatch(send(c.threadId, "first", { type: "start_immediately" }));
            yield* Fiber.join(running);
            const first = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
            assert.equal(first.capabilityEvidence?.status, "current");
            assert.equal(first.capabilityEvidence?.observation, "provider-start");
            const key = mode === "queue" ? "queued" : "replacement";
            const done = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "run.updated" &&
                  e.threadId === c.threadId &&
                  e.payload.status === "completed" &&
                  (mode === "queue" ? e.payload.userMessageId === key : e.payload.id === first.id),
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            const command = send(
              c.threadId,
              key,
              mode === "queue"
                ? { type: "queue_after_active" }
                : {
                    type: mode === "steer" ? "steer_active" : "restart_active",
                    targetRunId: first.id,
                  },
            );
            if (mode === "queue") yield* f.dispatch(command);
            f.setProviders([
              {
                ...provider,
                workspaceSnapshots: [
                  {
                    ...provider.workspaceSnapshots![0]!,
                    skills: mode === "restart-removed" ? [] : [{ ...skill, enabled: false }],
                  },
                ],
              },
            ]);
            if (mode !== "queue") yield* f.dispatch(command, kernel);
            if (mode === "queue" || mode === "steer") {
              yield* f.worker.drain();
              yield* finishFirst();
            }
            yield* Fiber.join(done);
            yield* f.settle(mode === "steer" ? "first" : key);
            yield* f.worker.drain();
            const after = yield* f.orchestrator.getThreadProjection(c.threadId);
            const run = after.runs.find(
              (r) => r.userMessageId === (mode === "steer" ? "first" : key),
            )!;
            assert.equal(run.capabilityEvidence?.status, "stale");
            assert.deepEqual(run.capabilityEvidence?.reviewed, c.taskCreationReview.capabilityPlan);
            assert.equal(run.capabilityDispatchEvidence?.status, "current");
            const attempts = after.attempts.filter((a) => a.runId === run.id);
            if (mode === "queue") assert.equal(attempts[0]?.capabilityEvidence?.status, "stale");
            else {
              assert.equal(attempts[0]?.capabilityEvidence?.status, "current");
              if (mode !== "steer")
                assert.equal(attempts.at(-1)?.capabilityEvidence?.status, "stale");
            }
            assert.equal(
              run.capabilityEvidence?.observation,
              mode === "steer" ? "dispatch" : "provider-start",
            );
            yield* f.dispatch(command, mode === "queue" ? undefined : kernel);
            yield* f.worker.drain();
            assert.equal((yield* Ref.get(f.started)).length, mode === "steer" ? 1 : 2);
            const beforeRebuild = run.capabilityEvidence;
            yield* f.rebuild;
            assert.deepEqual(
              (yield* f.orchestrator.getThreadProjection(c.threadId)).runs.find(
                (r) => r.id === run.id,
              )?.capabilityEvidence,
              beforeRebuild,
            );
            const result = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === c.threadId,
            )!.resultReadout;
            assert.equal(
              result?.status === "available" && result.capabilityEvidence?.status,
              "stale",
            );
          }),
        {
          governedWorker: mode === "queue",
          onStart: (input, events, emit) =>
            Effect.gen(function* () {
              if (++starts === 1) {
                finishFirst = () => Effect.forEach(events, emit, { discard: true });
                const root = events.find((e) => e.type === "provider_turn.updated");
                if (!root || root.type !== "provider_turn.updated")
                  throw new Error("Missing native root");
                yield* emit({
                  ...root,
                  providerTurn: { ...root.providerTurn, status: "running", completedAt: null },
                });
              } else yield* Effect.forEach(events, emit, { discard: true });
            }),
          onInterrupt: (_input, events, emit) =>
            Effect.gen(function* () {
              const root = events.find((e) => e.type === "provider_turn.updated");
              const terminal = events.find((e) => e.type === "turn.terminal");
              if (
                !root ||
                root.type !== "provider_turn.updated" ||
                !terminal ||
                terminal.type !== "turn.terminal"
              )
                throw new Error("Missing interrupted root");
              yield* emit({
                ...root,
                providerTurn: {
                  ...root.providerTurn,
                  status: "interrupted",
                  completedAt: yield* DateTime.now,
                },
              });
              yield* emit({ ...terminal, status: "interrupted", failure: null });
            }),
        },
      );
    }),
);

it.live(
  "prepared release revalidates advisory inventory at provider start without a second admission",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const roots = yield* f.sql<{
            workspace_root: string;
          }>`SELECT workspace_root FROM projection_projects WHERE project_id='project-a'`;
          const workspace = roots[0]!.workspace_root;
          const provider: ServerProvider = {
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
          };
          f.setProviders([provider]);
          const base = { ...agentsCreationCommand("fresh-prepared"), taskContract: contract };
          const c = {
            ...base,
            taskCreationReview: {
              ...base.taskCreationReview!,
              capabilityPlan: planTaskCapabilities({
                environmentId: "environment-a",
                projectId: base.projectId,
                workspace,
                modelSelection: base.modelSelection,
                contract,
                provider,
              }),
            },
          };
          yield* f.dispatch(c);
          yield* f.dispatch(send(c.threadId, "prepared", { type: "defer_start" }));
          const run = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
          assert.equal(run.capabilityEvidence?.status, "current");
          const before = yield* f.sql`SELECT * FROM task_contract_admissions`;
          f.setProviders([{ ...provider, workspaceSnapshots: [] }]);
          const done = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "run.updated" &&
                e.payload.id === run.id &&
                e.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* f.dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make("release"),
            threadId: c.threadId,
            runId: run.id,
          });
          yield* Fiber.join(done);
          yield* f.settle("prepared");
          yield* f.worker.drain();
          const after = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
          assert.equal(after.capabilityEvidence?.status, "stale");
          assert.equal(after.capabilityEvidence?.observation, "provider-start");
          assert.equal(after.capabilityDispatchEvidence?.status, "current");
          assert.deepEqual(yield* f.sql`SELECT * FROM task_contract_admissions`, before);
          yield* f.rebuild;
          assert.equal(
            (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]?.capabilityEvidence
              ?.status,
            "stale",
          );
          assert.equal((yield* Ref.get(f.started)).length, 1);
        }),
      { governedWorker: true },
    ),
);
