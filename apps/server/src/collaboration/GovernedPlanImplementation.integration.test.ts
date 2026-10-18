import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  PlanId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { agentsCreationCommand } from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const planId = PlanId.make("governed-plan");
const planAdapter = {
  governedWorker: true,
  onStart: (input, events, emit) =>
    Effect.gen(function* () {
      if (input.threadId === "plan-source" && input.runOrdinal === 1) {
        yield* emit({
          type: "plan.updated",
          driver: ProviderDriverKind.make("codex"),
          plan: {
            id: planId,
            threadId: input.threadId,
            runId: input.runId,
            nodeId: input.rootNodeId,
            kind: "proposed_plan",
            status: "active",
            markdown: "Implement the reviewed plan.",
          },
        });
      }
      yield* Effect.forEach(events, emit, { discard: true });
    }),
} satisfies NonNullable<Parameters<typeof withTaskResultLinkageFixture>[1]>;

it.live.each(["active", "exhausted", "paused", "missing contract"] as const)(
  "governed plan cannot escape to an ordinary root: %s",
  (state) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const source = {
            ...agentsCreationCommand("plan-source"),
            taskContract: {
              goal: "Implement plan",
              redirect: "Disposable fixture",
              acceptance: "Review output",
              brake: {
                maxProviderStarts: state === "active" ? 2 : 1,
                stopConditions: "Scope changed",
              },
            },
          };
          yield* f.dispatch(source);
          yield* f.execute(source, "plan-first");
          if (state === "paused" || state === "missing contract") {
            yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json, '$.taskContractPhase', ${state === "paused" ? "paused" : "active"}, '$.taskContract', CASE WHEN ${state} = 'missing contract' THEN NULL ELSE json_extract(payload_json, '$.taskContract') END) WHERE thread_id=${source.threadId}`;
          }
          const {
            taskGovernance: _g,
            taskContract: _c,
            taskCreationReview: _r,
            ...target
          } = agentsCreationCommand("plan-target");
          const governedTarget = {
            ...source,
            threadId: agentsCreationCommand("plan-governed-target").threadId,
            commandId: CommandId.make("create-governed-target"),
          };
          yield* f.dispatch(target);
          yield* f.dispatch(governedTarget);
          const reservations = () => f.sql`
            SELECT 'admissions' AS kind, COUNT(*) AS n FROM task_contract_admissions
            UNION ALL SELECT 'leases', COUNT(*) FROM base3_capacity_leases
            UNION ALL SELECT 'grants', COUNT(*) FROM base3_execution_grants
            UNION ALL SELECT 'outbox', COUNT(*) FROM orchestration_v2_effect_outbox`;
          const before = yield* reservations();
          const dispatchModes: Extract<
            OrchestrationV2Command,
            { type: "message.dispatch" }
          >["dispatchMode"][] = [
            { type: "start_immediately" },
            { type: "defer_start" },
            { type: "queue_after_active" },
            { type: "steer_active", targetRunId: RunId.make("absent-active") },
            { type: "restart_active", targetRunId: RunId.make("absent-active") },
          ];
          for (const destination of [target, governedTarget]) {
            for (const mode of dispatchModes) {
              for (const suffix of ["same", "same", "new"]) {
                const key = `escape-${destination.threadId}-${mode.type}-${suffix}`;
                const result = yield* f
                  .dispatch({
                    type: "message.dispatch",
                    commandId: CommandId.make(key),
                    threadId: destination.threadId,
                    messageId: MessageId.make(key),
                    text: "Implement",
                    attachments: [],
                    sourcePlanRef: { threadId: source.threadId, planId },
                    dispatchMode: mode,
                    createdBy: "user",
                    creationSource: "web",
                  })
                  .pipe(Effect.exit);
                assert.isTrue(
                  Exit.isFailure(result),
                  "A governed plan must stay inside its reviewed task",
                );
                assert.deepEqual(
                  yield* reservations(),
                  before,
                  "Refusal must precede every authorization reservation",
                );
              }
            }
            assert.equal(
              (yield* f.orchestrator.getThreadProjection(destination.threadId)).runs.length,
              0,
            );
          }
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 1);
          const plans = yield* f.sql<{
            status: string;
          }>`SELECT status FROM orchestration_v2_projection_plans WHERE plan_id=${planId}`;
          assert.equal(plans[0]?.status, "active");
          if (state !== "active") {
            const ownResult = yield* f
              .execute(source, "same-task-blocked", {
                sourcePlanRef: { threadId: source.threadId, planId },
              })
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(ownResult));
            assert.equal((yield* Ref.get(f.started)).length, 1);
          }
        }),
      planAdapter,
    ),
);

it.live(
  "ordinary plans still implement across roots; governed plans implement within their own task",
  () =>
    Effect.forEach(
      [false, true],
      (governed) =>
        withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const base = {
                ...agentsCreationCommand("plan-source"),
                taskContract: {
                  goal: "Implement plan",
                  redirect: "Disposable fixture",
                  acceptance: "Review output",
                  brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
                },
              };
              const {
                taskGovernance: _g,
                taskContract: _c,
                taskCreationReview: _r,
                ...chat
              } = base;
              const source = governed ? base : chat;
              yield* f.dispatch(source);
              yield* f.execute(source, "plan-first");
              const target = governed
                ? source
                : {
                    ...chat,
                    threadId: agentsCreationCommand("plan-target").threadId,
                    commandId: CommandId.make("create-target"),
                  };
              if (!governed) yield* f.dispatch(target);
              yield* f.execute(target, "plan-implementation", {
                sourcePlanRef: { threadId: source.threadId, planId },
              });
              assert.equal((yield* Ref.get(f.started)).length, 2);
              const plans = yield* f.sql<{
                status: string;
              }>`SELECT status FROM orchestration_v2_projection_plans WHERE plan_id=${planId}`;
              assert.equal(plans[0]?.status, "completed");
            }),
          planAdapter,
        ),
      { discard: true },
    ),
);
