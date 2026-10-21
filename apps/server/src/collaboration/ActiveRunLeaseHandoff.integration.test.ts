import * as Schema from "effect/Schema";
import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { confirmProviderTermination } from "../policy/Base3PolicyGate.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  RunAttemptId,
  EventId,
  ProviderTurnId,
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
  agentsCreationActor,
  agentsCreationCommand,
  agentsCreationProvider,
} from "./testkit/agentsTaskCreationFixture.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";

const decodeEffect = Schema.decodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

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
  "authenticated default-limit1 %s preserves one occupied slot, budget and attempt history",
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
            yield* f.dispatch(c, agentsCreationActor);
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
            yield* f.dispatch(
              send(c.threadId, "first", { type: "start_immediately" }),
              agentsCreationActor,
            );
            yield* Fiber.join(running);
            const first = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
            const initialLeases =
              yield* f.sql`SELECT * FROM base3_capacity_leases WHERE released_at IS NULL`;
            assert.equal(initialLeases.length, 1);
            assert.equal(initialLeases[0]!.run_id, first.id);
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
            if (mode === "queue") yield* f.dispatch(command, agentsCreationActor);
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
            if (mode !== "queue") yield* f.dispatch(command, agentsCreationActor);
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
            yield* f.dispatch(command, agentsCreationActor);
            yield* f.worker.drain();
            assert.equal((yield* Ref.get(f.started)).length, mode === "steer" ? 1 : 2);
            const leases = yield* f.sql`SELECT * FROM base3_capacity_leases`;
            assert.equal(leases.length, mode === "queue" ? 2 : 1);
            assert.isTrue(leases.every((l) => l.released_at !== null));
            const admissions = yield* f.sql`SELECT * FROM task_contract_admissions`;
            assert.equal(admissions.length, mode === "steer" ? 1 : 2);
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
          governedWorker: true,
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

type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
type Run = import("@t3tools/contracts").OrchestrationV2Run;
interface Held {
  readonly f: Fixture;
  readonly first: Run;
  readonly finish: () => Effect.Effect<void>;
  readonly terminal: (confirmed?: boolean) => Effect.Effect<void>;
  readonly steerCount: () => number;
  readonly lateOldTerminal: () => Effect.Effect<void>;
  readonly interruptCount: () => number;
}
const withHeld = <E>(
  check: (held: Held) => Effect.Effect<void, E, import("effect/Scope").Scope>,
  options: {
    readonly dbPath?: string;
    readonly beforeCommit?: () => Effect.Effect<void>;
    readonly confirmed?: boolean;
    readonly quietReplacement?: boolean;
    readonly restartSession?: boolean;
    readonly maxStarts?: number;
    readonly interrupt?: (emitTerminal: () => Effect.Effect<void>) => Effect.Effect<void>;
  } = {},
) => {
  let finish = () => Effect.void;
  let terminal = (_confirmed = true) => Effect.void;
  let steerCount = 0;
  let lateOldTerminal = () => Effect.void;
  let nativeActive = false;
  let nativeStarts = 0;
  let interruptCount = 0;
  return withTaskResultLinkageFixture(
    (f) =>
      Effect.gen(function* () {
        const c = {
          ...agentsCreationCommand("lease-held"),
          taskContract: {
            ...contract,
            brake: { ...contract.brake, maxProviderStarts: options.maxStarts ?? 3 },
          },
        };
        yield* f.dispatch(c, agentsCreationActor);
        const running = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.dispatch(
          send(c.threadId, "held-first", { type: "start_immediately" }),
          agentsCreationActor,
        );
        yield* f.worker.drain();
        yield* Fiber.join(running);
        const first = (yield* f.orchestrator.getThreadProjection(c.threadId)).runs[0]!;
        yield* check({
          f,
          first,
          finish: () => finish(),
          terminal: (confirmed) => terminal(confirmed),
          steerCount: () => steerCount,
          lateOldTerminal: () => lateOldTerminal(),
          interruptCount: () => interruptCount,
        });
      }),
    {
      governedWorker: true,
      startWorker: false,
      restartSessionOnSelectionChange: options.restartSession ?? false,
      ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
      ...(options.beforeCommit === undefined
        ? {}
        : {
            decorateEventSink: (service) => ({
              ...service,
              commitCommand: (input) =>
                (input.effects.some((e) => e.request.type === "provider-turn.restart")
                  ? options.beforeCommit!()
                  : Effect.void
                ).pipe(Effect.andThen(service.commitCommand(input))),
            }),
          }),
      onSteer: () =>
        Effect.sync(() => {
          steerCount++;
        }),
      onStart: (_input, events, emit) =>
        Effect.gen(function* () {
          assert.isFalse(nativeActive, "default limit1 must never overlap actual native attempts");
          nativeActive = true;
          nativeStarts++;
          if (nativeStarts > 1 && options.quietReplacement) return;
          finish = () =>
            Effect.sync(() => {
              nativeActive = false;
            }).pipe(Effect.andThen(Effect.forEach(events, emit, { discard: true })));
          const root = events.find((e) => e.type === "provider_turn.updated");
          const end = events.find((e) => e.type === "turn.terminal");
          if (root?.type !== "provider_turn.updated" || end?.type !== "turn.terminal")
            throw new Error("missing native fixture terminal");
          terminal = (confirmed = true) =>
            Effect.gen(function* () {
              yield* emit({
                ...root,
                providerTurn: {
                  ...root.providerTurn,
                  status: "interrupted",
                  completedAt: yield* DateTime.now,
                  terminationConfirmed: confirmed,
                },
              });
              yield* emit({ ...end, status: "interrupted", failure: null });
            });
          if (nativeStarts === 1) lateOldTerminal = terminal;
          yield* emit({
            ...root,
            providerTurn: { ...root.providerTurn, status: "running", completedAt: null },
          });
        }),
      onInterrupt: (_input, events, emit) => {
        interruptCount++;
        const root = events.find((e) => e.type === "provider_turn.updated");
        const end = events.find((e) => e.type === "turn.terminal");
        const emitTerminal = () =>
          Effect.gen(function* () {
            if (options.confirmed !== false) nativeActive = false;
            if (root?.type !== "provider_turn.updated" || end?.type !== "turn.terminal")
              throw new Error("missing native interrupt");
            yield* emit({
              ...root,
              providerTurn: {
                ...root.providerTurn,
                status: "interrupted",
                completedAt: yield* DateTime.now,
                terminationConfirmed: options.confirmed ?? true,
              },
            });
            yield* emit({ ...end, status: "interrupted", failure: null });
          });
        return options.interrupt ? options.interrupt(emitTerminal) : emitTerminal();
      },
    },
  );
};
const occupied = (f: Fixture) =>
  f.sql`SELECT lease_id,run_id,message_id,status,released_at FROM base3_capacity_leases WHERE released_at IS NULL`;
const admissions = (f: Fixture) =>
  f.sql`SELECT command_id,message_id FROM task_contract_admissions ORDER BY command_id`;

it.live.each([
  "actor",
  "scope",
  "thread",
  "run",
  "attempt",
  "missing-grant",
  "revoked-grant",
  "expired-grant",
  "expired-session",
  "disconnect",
  "interrupt",
  "revision",
  "capacity",
  "planning",
] as const)("authenticated %s rejection preserves the occupied lease and provider budget", (mode) =>
  withHeld(({ f, first }) =>
    Effect.gen(function* () {
      const beforeLease = yield* occupied(f);
      const beforeAdmissions = yield* admissions(f);
      let command = send(first.threadId, `deny-${mode}`, {
        type: "restart_active",
        targetRunId: first.id,
        targetAttemptId: first.activeAttemptId!,
      });
      if (command.type !== "message.dispatch") throw new Error("wrong command");
      let actor: import("../policy/executionContext.ts").PolicyExecutionContext =
        agentsCreationActor;
      if (mode === "actor") actor = { ...actor, actorId: "unrelated-actor" };
      if (mode === "scope") actor = { ...agentsCreationActor, scopes: [] };
      if (mode === "expired-session") actor = { ...agentsCreationActor, expiresAt: "2000-01-01" };
      if (mode === "thread") {
        const other = { ...agentsCreationCommand("unrelated-thread"), taskContract: contract };
        yield* f.dispatch(other, agentsCreationActor);
        command = { ...command, threadId: other.threadId };
      }
      if (mode === "run")
        command = {
          ...command,
          dispatchMode: { type: "restart_active", targetRunId: RunId.make("unrelated-run") },
        };
      if (mode === "attempt")
        command = {
          ...command,
          dispatchMode: {
            type: "restart_active",
            targetRunId: first.id,
            targetAttemptId: RunAttemptId.make("stale-attempt"),
          },
        };
      const grantId = `grant:message:${first.threadId}:held-first`;
      if (mode === "missing-grant")
        yield* f.sql`DELETE FROM base3_execution_grants WHERE grant_id=${grantId}`;
      if (mode === "revoked-grant")
        yield* f.sql`UPDATE base3_execution_grants SET revoked_at='2026-01-01' WHERE grant_id=${grantId}`;
      if (mode === "expired-grant")
        yield* f.sql`UPDATE base3_execution_grants SET expires_at='2000-01-01' WHERE grant_id=${grantId}`;
      if (mode === "disconnect")
        yield* f.sql`UPDATE base3_capacity_leases SET disconnect_unconfirmed=1`;
      if (mode === "interrupt")
        yield* f.sql`UPDATE base3_capacity_leases SET interrupt_requested=1`;
      if (mode === "revision")
        yield* f.dispatch(
          {
            type: "thread.task-contract.set",
            commandId: CommandId.make("revise"),
            threadId: first.threadId,
            ...contract,
            goal: "Changed contract",
          },
          agentsCreationActor,
        );
      if (mode === "capacity")
        command = { ...command, dispatchMode: { type: "start_immediately" } };
      if (mode === "planning") command = { ...command, text: "/compact" };
      const denied = yield* Effect.exit(f.dispatch(command, actor));
      assert.equal(denied._tag, "Failure");
      assert.deepEqual(yield* occupied(f), beforeLease);
      // Ordinary admission's existing budget reservation is separate; active controls allocate none.
      if (mode !== "capacity") assert.deepEqual(yield* admissions(f), beforeAdmissions);
      assert.equal((yield* Ref.get(f.started)).length, 1);
    }),
  ),
);

it.live(
  "true steer works with an exhausted start budget and does not add an attempt or lease",
  () =>
    withHeld(
      ({ f, first, steerCount }) =>
        Effect.gen(function* () {
          const before = yield* admissions(f);
          const c = send(first.threadId, "one-start-steer", {
            type: "steer_active",
            targetRunId: first.id,
          });
          yield* f.dispatch(c, agentsCreationActor);
          yield* f.worker.drain();
          assert.equal(steerCount(), 1);
          assert.equal((yield* Ref.get(f.started)).length, 1);
          assert.equal((yield* occupied(f)).length, 1);
          assert.deepEqual(yield* admissions(f), before);
          yield* f.dispatch(c, agentsCreationActor);
          yield* f.worker.drain();
          assert.equal(steerCount(), 1);
          assert.equal(
            (yield* Effect.exit(f.dispatch(c, { ...agentsCreationActor, actorId: "other" })))._tag,
            "Failure",
          );
        }),
      { maxStarts: 1 },
    ),
);

it.live(
  "competing restarts and replay start exactly one replacement; old terminal cannot release its lease",
  () =>
    withHeld(({ f, first, finish, lateOldTerminal }) =>
      Effect.gen(function* () {
        const a = send(first.threadId, "restart-a", {
          type: "restart_active",
          targetRunId: first.id,
          targetAttemptId: first.activeAttemptId!,
        });
        const b = send(first.threadId, "restart-b", {
          type: "restart_active",
          targetRunId: first.id,
          targetAttemptId: first.activeAttemptId!,
        });
        const results = yield* Effect.all(
          [
            Effect.exit(f.dispatch(a, agentsCreationActor)),
            Effect.exit(f.dispatch(b, agentsCreationActor)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((r) => r._tag === "Success").length, 1);
        const won = results[0]!._tag === "Success" ? a : b;
        yield* f.dispatch(won, agentsCreationActor);
        const running = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (e) =>
              e.type === "provider-turn.updated" &&
              e.payload.status === "running" &&
              e.payload.runAttemptId !== first.activeAttemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* f.worker.drain();
        assert.equal((yield* Ref.get(f.started)).length, 2);
        yield* Fiber.join(running);
        assert.equal((yield* Ref.get(f.started)).length, 2);
        const projection = yield* f.orchestrator.getThreadProjection(first.threadId);
        const replacement = projection.runs[0]!;
        assert.notEqual(replacement.activeAttemptId, first.activeAttemptId);
        assert.equal(
          projection.attempts.find((a) => a.id === first.activeAttemptId)!.status,
          "interrupted",
        );
        assert.isNotNull(
          projection.attempts.find((a) => a.id === first.activeAttemptId)!.completedAt,
        );
        assert.equal((yield* occupied(f)).length, 1);
        yield* f.rebuild;
        yield* f.dispatch(won, agentsCreationActor);
        yield* f.worker.drain();
        assert.equal((yield* Ref.get(f.started)).length, 2);
        assert.equal((yield* admissions(f)).length, 2);
        // Redeliver the old native terminal after the replacement is running.
        const old = projection.providerTurns.find((t) => t.runAttemptId === first.activeAttemptId)!;
        yield* lateOldTerminal();
        yield* confirmProviderTermination({
          threadId: first.threadId,
          runId: first.id,
          attemptId: old.runAttemptId!,
        }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql));
        assert.equal((yield* occupied(f)).length, 1);
        const done = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter((e) => e.type === "run.updated" && e.payload.status === "waiting"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* finish();
        yield* Fiber.join(done);
        yield* f.worker.drain();
        assert.equal(
          (yield* f.orchestrator.getThreadProjection(first.threadId)).runs[0]!.status,
          "completed",
        );
        assert.equal((yield* occupied(f)).length, 0);
      }),
    ),
);

it.live.each([
  "missing-session",
  "interrupt-failure",
  "interrupt-timeout",
  "unconfirmed-terminal",
] as const)("%s never overlaps replacement work or spends another provider reservation", (mode) =>
  withHeld(
    ({ f, first }) =>
      Effect.gen(function* () {
        yield* f.dispatch(
          send(first.threadId, "uncertain-restart", {
            type: "restart_active",
            targetRunId: first.id,
          }),
          agentsCreationActor,
        );
        if (mode === "missing-session") {
          const p = yield* f.orchestrator.getThreadProjection(first.threadId);
          yield* f.sessions.close(p.providerThreads[0]!.providerSessionId!);
        }
        yield* f.worker.runOnce;
        assert.equal((yield* Ref.get(f.started)).length, 1);
        assert.equal((yield* occupied(f)).length, 1);
        assert.equal((yield* admissions(f)).length, 1);
        const uncertain = yield* f.orchestrator.getThreadProjection(first.threadId);
        const oldAttempt = uncertain.attempts.find((a) => a.id === first.activeAttemptId)!;
        assert.equal(oldAttempt.status, "running");
        assert.isNull(oldAttempt.completedAt);
        assert.equal(uncertain.nodes.find((n) => n.id === first.rootNodeId)!.status, "running");
        const pending =
          yield* f.sql`SELECT status,last_error FROM orchestration_v2_effect_outbox WHERE effect_type='provider-turn.restart'`;
        assert.isTrue(pending[0]!.status !== "succeeded");
        yield* f.rebuild;
        yield* f.sql`UPDATE orchestration_v2_effect_outbox SET available_at='2000-01-01' WHERE effect_type='provider-turn.restart'`;
        yield* f.worker.runOnce;
        assert.equal((yield* Ref.get(f.started)).length, 1);
        assert.equal((yield* occupied(f)).length, 1);
        assert.equal((yield* admissions(f)).length, 1);
      }),
    {
      confirmed: mode !== "unconfirmed-terminal",
      interrupt:
        mode === "interrupt-failure"
          ? () => Effect.die("controlled native interrupt failure")
          : mode === "unconfirmed-terminal"
            ? (emit) => emit()
            : () => Effect.void,
    },
  ),
);

it.live.each([
  "cancel-before-terminal",
  "cancel-after-terminal",
  "revoked-after-interrupt",
  "expired-after-interrupt",
] as const)(
  "%s cannot start replacement and retains capacity until native stop is confirmed",
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withHeld(
        ({ f, first, terminal }) =>
          Effect.gen(function* () {
            const stopped = yield* f.orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (e) =>
                  e.type === "provider-turn.updated" &&
                  e.payload.runAttemptId === first.activeAttemptId &&
                  e.payload.status === "interrupted",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            const c = send(first.threadId, "blocked-restart", {
              type: "restart_active",
              targetRunId: first.id,
            });
            yield* f.dispatch(c, agentsCreationActor);
            const delivery = yield* f.worker.runOnce.pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            if (mode !== "cancel-after-terminal") {
              const pending = yield* f.orchestrator.getThreadProjection(first.threadId);
              assert.equal(
                pending.attempts.find((a) => a.id === first.activeAttemptId)!.status,
                "running",
              );
              assert.isNull(
                pending.attempts.find((a) => a.id === first.activeAttemptId)!.completedAt,
              );
            }
            assert.equal((yield* Ref.get(f.started)).length, 1);
            assert.equal((yield* admissions(f)).length, 1);
            assert.equal((yield* occupied(f)).length, 1);
            if (mode === "cancel-after-terminal") yield* Fiber.join(stopped);
            if (mode.startsWith("cancel")) {
              yield* f.dispatch(
                {
                  type: "run.interrupt",
                  commandId: CommandId.make("cancel-replacement"),
                  threadId: first.threadId,
                  runId: first.id,
                },
                agentsCreationActor,
              );
              if (mode === "cancel-before-terminal") {
                assert.equal((yield* occupied(f)).length, 1);
                yield* terminal();
                yield* Fiber.join(stopped);
              }
            } else {
              const grantId = `grant:message:${first.threadId}:blocked-restart`;
              if (mode.startsWith("revoked"))
                yield* f.sql`UPDATE base3_execution_grants SET revoked_at='2026-01-01' WHERE grant_id=${grantId}`;
              else
                yield* f.sql`UPDATE base3_execution_grants SET expires_at='2000-01-01' WHERE grant_id=${grantId}`;
            }
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(delivery);
            if (!mode.startsWith("cancel")) {
              yield* Fiber.join(stopped);
              assert.equal((yield* occupied(f)).length, 1);
              // The confirmed stopped/pending handoff remains recoverable by ordinary Stop.
              yield* f.dispatch(
                {
                  type: "run.interrupt",
                  commandId: CommandId.make("stop-denied-handoff"),
                  threadId: first.threadId,
                  runId: first.id,
                },
                agentsCreationActor,
              );
            }
            assert.equal((yield* Ref.get(f.started)).length, 1);
            assert.equal((yield* admissions(f)).length, 1);
            assert.equal((yield* occupied(f)).length, 0);
            yield* f.rebuild;
            yield* f.worker.drain();
            assert.equal((yield* Ref.get(f.started)).length, 1);
          }),
        {
          interrupt: (emit) =>
            mode === "cancel-after-terminal"
              ? emit().pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Deferred.await(release)),
                )
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(emit()),
                ),
        },
      );
    }),
);

it.live.each(["revoked", "expired", "newer-grant"] as const)(
  "delivery cannot borrow another grant when its exact command grant is %s",
  (mode) => {
    let interrupts = 0;
    return withHeld(
      ({ f, first }) =>
        Effect.gen(function* () {
          yield* f.dispatch(
            send(first.threadId, "pinned-control", {
              type: "restart_active",
              targetRunId: first.id,
            }),
            agentsCreationActor,
          );
          const grantId = `grant:message:${first.threadId}:pinned-control`;
          if (mode === "expired")
            yield* f.sql`UPDATE base3_execution_grants SET expires_at='2000-01-01' WHERE grant_id=${grantId}`;
          else
            yield* f.sql`UPDATE base3_execution_grants SET revoked_at='2026-01-01' WHERE grant_id=${grantId}`;
          if (mode === "newer-grant") {
            yield* f.sql`INSERT INTO base3_execution_grants SELECT ${`grant:message:${first.threadId}:newer`},thread_id,'newer',run_id,operation,actor_id,scopes_json,NULL,argument_hash,approval_id,NULL,created_at FROM base3_execution_grants WHERE grant_id=${grantId}`;
            yield* f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.userMessageId','newer') WHERE run_id=${first.id}`;
          }
          yield* f.worker.runOnce;
          assert.equal(interrupts, 0);
          assert.equal((yield* Ref.get(f.started)).length, 1);
          assert.equal((yield* admissions(f)).length, 1);
          assert.equal((yield* occupied(f)).length, 1);
        }),
      {
        interrupt: (emit) => {
          interrupts++;
          return emit();
        },
      },
    );
  },
);

it.live(
  "native finish during planning cannot resurrect the run or transfer a released slot",
  () => {
    let beforeCommit = () => Effect.void;
    return withHeld(
      ({ f, first, finish }) =>
        Effect.gen(function* () {
          const waiting = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter((e) => e.type === "run.updated" && e.payload.status === "waiting"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          beforeCommit = () =>
            Effect.gen(function* () {
              const nativeDone = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) => e.type === "provider-turn.updated" && e.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* finish();
              yield* Fiber.join(nativeDone);
            }).pipe(Effect.scoped, Effect.orDie);
          const denied = yield* Effect.exit(
            f.dispatch(
              send(first.threadId, "finish-race", {
                type: "restart_active",
                targetRunId: first.id,
              }),
              agentsCreationActor,
            ),
          );
          assert.equal(denied._tag, "Failure");
          yield* Fiber.join(waiting);
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 1);
          assert.equal((yield* occupied(f)).length, 0);
          assert.equal((yield* admissions(f)).length, 1);
          const p = yield* f.orchestrator.getThreadProjection(first.threadId);
          assert.equal(p.runs[0]!.activeAttemptId, first.activeAttemptId);
          assert.equal(p.runs[0]!.status, "completed");
          assert.equal(p.attempts.length, 1);
        }),
      { beforeCommit: () => beforeCommit() },
    );
  },
);

it.live(
  "process loss before handoff leaves UNKNOWN native work occupied without a blind replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "b3r-lease-recovery-" });
        const dbPath = path.join(dir, "recovery.sqlite");
        yield* withHeld(
          ({ f, first }) =>
            Effect.gen(function* () {
              yield* f.dispatch(
                send(first.threadId, "recover-control", {
                  type: "restart_active",
                  targetRunId: first.id,
                }),
                agentsCreationActor,
              );
              assert.equal((yield* Ref.get(f.started)).length, 1);
              assert.equal((yield* occupied(f)).length, 1);
            }),
          { dbPath },
        );
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              yield* f.worker.runOnce;
              assert.equal((yield* Ref.get(f.started)).length, 0);
              assert.equal((yield* occupied(f)).length, 1);
              assert.equal((yield* admissions(f)).length, 1);
              const p = yield* f.orchestrator.getThreadProjection(
                agentsCreationCommand("lease-held").threadId,
              );
              assert.equal(p.runs[0]!.status, "starting");
              assert.equal(p.providerTurns[0]!.status, "running");
              assert.isTrue(p.providerTurns[0]!.terminationConfirmed !== true);
            }),
          { dbPath, governedWorker: true, startWorker: false },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "steer after native completion uses ordinary follow-up capacity and budget exactly once",
  () =>
    withHeld(
      ({ f, first, finish, steerCount }) =>
        Effect.gen(function* () {
          const steer = send(first.threadId, "completed-steer", {
            type: "steer_active",
            targetRunId: first.id,
          });
          yield* f.dispatch(steer, agentsCreationActor);
          assert.equal((yield* admissions(f)).length, 1);
          const nativeDone = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) => e.type === "provider-turn.updated" && e.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* finish();
          yield* Fiber.join(nativeDone);
          assert.equal((yield* occupied(f)).length, 0);
          const newRunning = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "provider-turn.updated" &&
                e.payload.status === "running" &&
                e.runId !== first.id,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(
            Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, f.worker),
            Effect.forkScoped,
          );
          yield* Fiber.join(newRunning);
          const p = yield* f.orchestrator.getThreadProjection(first.threadId);
          assert.equal(p.runs.length, 2);
          assert.equal((yield* Ref.get(f.started)).length, 2);
          assert.equal(steerCount(), 0);
          assert.equal((yield* admissions(f)).length, 2);
          assert.equal((yield* occupied(f)).length, 1);
          const leases =
            yield* f.sql`SELECT run_id,status FROM base3_capacity_leases ORDER BY created_at`;
          assert.equal(leases.length, 2);
          assert.equal(leases[0]!.status, "released");
          assert.notEqual(leases[0]!.run_id, leases[1]!.run_id);
          yield* f.dispatch(steer, agentsCreationActor);
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 2);
          assert.equal((yield* admissions(f)).length, 2);
        }),
      { maxStarts: 2 },
    ),
);

it.live(
  "authenticated steer fallback reserves exactly one replacement start at default capacity",
  () =>
    withHeld(
      ({ f, first }) =>
        Effect.gen(function* () {
          f.setProviders([
            {
              ...agentsCreationProvider,
              models: [
                ...agentsCreationProvider.models,
                { ...agentsCreationProvider.models[0]!, slug: "other-model" },
              ],
            },
          ]);
          const base = send(first.threadId, "fallback-steer", {
            type: "steer_active",
            targetRunId: first.id,
          });
          if (base.type !== "message.dispatch") throw new Error("wrong fixture command");
          const c = {
            ...base,
            modelSelection: { instanceId: agentsCreationProvider.instanceId, model: "other-model" },
            routingMode: "manual" as const,
          };
          yield* f.dispatch(c, agentsCreationActor);
          assert.equal((yield* admissions(f)).length, 1);
          const running = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "provider-turn.updated" &&
                e.payload.status === "running" &&
                e.payload.runAttemptId !== first.activeAttemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* f.worker.drain();
          yield* Fiber.join(running);
          assert.equal((yield* Ref.get(f.started)).length, 2);
          assert.equal((yield* admissions(f)).length, 2);
          assert.equal((yield* occupied(f)).length, 1);
          assert.equal((yield* f.sql`SELECT lease_id FROM base3_capacity_leases`).length, 1);
          const p = yield* f.orchestrator.getThreadProjection(first.threadId);
          assert.equal(p.attempts.length, 2);
          assert.equal(p.runs[0]!.modelSelection.model, "other-model");
          yield* f.dispatch(c, agentsCreationActor);
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 2);
          assert.equal((yield* admissions(f)).length, 2);
        }),
      { maxStarts: 2 },
    ),
);

it.live("a terminal recovery projection cannot free an unconfirmed started replacement", () =>
  withHeld(
    ({ f, first }) =>
      Effect.gen(function* () {
        yield* f.dispatch(
          send(first.threadId, "quiet-replacement", {
            type: "restart_active",
            targetRunId: first.id,
          }),
          agentsCreationActor,
        );
        yield* f.worker.drain();
        assert.equal((yield* Ref.get(f.started)).length, 2);
        const p = yield* f.orchestrator.getThreadProjection(first.threadId);
        const current = p.runs[0]!;
        const attempt = p.attempts.find((a) => a.id === current.activeAttemptId)!;
        assert.isNotNull(attempt.startedAt);
        assert.isNull(attempt.providerTurnId);
        const now = yield* DateTime.now;
        yield* f.eventSink.write({
          events: [
            {
              id: EventId.make("recovery-run"),
              type: "run.updated",
              threadId: first.threadId,
              runId: first.id,
              occurredAt: now,
              payload: { ...current, status: "interrupted", completedAt: now },
            },
            {
              id: EventId.make("recovery-attempt"),
              type: "run-attempt.updated",
              threadId: first.threadId,
              runId: first.id,
              occurredAt: now,
              payload: { ...attempt, status: "interrupted", completedAt: now },
            },
          ],
        });
        yield* confirmProviderTermination({
          threadId: first.threadId,
          runId: first.id,
          attemptId: first.activeAttemptId!,
        }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql));
        assert.equal((yield* occupied(f)).length, 1);
        yield* f.rebuild;
        yield* f.worker.drain();
        assert.equal((yield* Ref.get(f.started)).length, 2);
        assert.equal((yield* occupied(f)).length, 1);
      }),
    { quietReplacement: true, maxStarts: 2 },
  ),
);

it.live("unattributed native terminal cannot release a modern active attempt", () =>
  withHeld(({ f, first }) =>
    Effect.gen(function* () {
      const p = yield* f.orchestrator.getThreadProjection(first.threadId);
      const native = p.providerTurns[0]!;
      const now = yield* DateTime.now;
      yield* f.eventSink.write({
        events: [
          {
            id: EventId.make("unattributed-terminal"),
            type: "provider-turn.updated",
            threadId: first.threadId,
            runId: first.id,
            occurredAt: now,
            payload: {
              ...native,
              id: ProviderTurnId.make("unattributed-native"),
              ordinal: 99,
              runAttemptId: null,
              status: "completed",
              completedAt: now,
              terminationConfirmed: true,
            },
          },
        ],
      });
      assert.equal((yield* occupied(f)).length, 1);
      assert.equal(
        (yield* f.orchestrator.getThreadProjection(first.threadId)).runs[0]!.activeAttemptId,
        first.activeAttemptId,
      );
      assert.equal((yield* Ref.get(f.started)).length, 1);
    }),
  ),
);

it.live("a new queued command cannot replace a pending active control's original grant", () =>
  withHeld(({ f, first }) =>
    Effect.gen(function* () {
      const original = send(first.threadId, "immutable-control", {
        type: "restart_active",
        targetRunId: first.id,
      });
      yield* f.dispatch(original, agentsCreationActor);
      const grantId = `grant:message:${first.threadId}:immutable-control`;
      const grant =
        yield* f.sql`SELECT actor_id,argument_hash,revoked_at FROM base3_execution_grants WHERE grant_id=${grantId}`;
      const base = send(first.threadId, "immutable-control", { type: "queue_after_active" });
      if (base.type !== "message.dispatch") throw new Error("wrong fixture command");
      const attempt = { ...base, commandId: CommandId.make("overwrite-control-grant") };
      assert.equal(
        (yield* Effect.exit(
          f.dispatch(attempt, { ...agentsCreationActor, actorId: "other-actor" }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(
        yield* f.sql`SELECT actor_id,argument_hash,revoked_at FROM base3_execution_grants WHERE grant_id=${grantId}`,
        grant,
      );
      assert.equal((yield* admissions(f)).length, 1);
      yield* f.worker.drain();
      assert.equal((yield* Ref.get(f.started)).length, 2);
      assert.equal((yield* admissions(f)).length, 2);
      assert.equal((yield* occupied(f)).length, 1);
    }),
  ),
);

it.live.each(["legacy", "guarded"] as const)(
  "changed-session %s cancellation interrupts the original native session before freeing capacity",
  (mode) =>
    withHeld(
      ({ f, first, interruptCount }) =>
        Effect.gen(function* () {
          f.setProviders([
            {
              ...agentsCreationProvider,
              models: [
                ...agentsCreationProvider.models,
                { ...agentsCreationProvider.models[0]!, slug: "other-model" },
              ],
            },
          ]);
          const before = yield* f.orchestrator.getThreadProjection(first.threadId);
          const oldThread = before.providerThreads.find((t) => t.id === first.providerThreadId)!;
          const base = send(first.threadId, "session-restart", {
            type: "restart_active",
            targetRunId: first.id,
          });
          if (base.type !== "message.dispatch") throw new Error("wrong fixture command");
          yield* f.dispatch(
            {
              ...base,
              routingMode: "manual",
              modelSelection: {
                instanceId: agentsCreationProvider.instanceId,
                model: "other-model",
              },
            },
            agentsCreationActor,
          );
          const pending = yield* f.orchestrator.getThreadProjection(first.threadId);
          const newThread = pending.providerThreads.find((t) => t.id === oldThread.id)!;
          assert.notEqual(newThread.providerSessionId, oldThread.providerSessionId);
          assert.equal(yield* Ref.get(f.opened), 1);
          yield* f.dispatch(
            {
              type: "run.interrupt",
              commandId: CommandId.make("cancel-session-restart"),
              threadId: first.threadId,
              runId: first.id,
              ...(mode === "guarded"
                ? { expectedAttemptId: pending.runs[0]!.activeAttemptId! }
                : {}),
            },
            agentsCreationActor,
          );
          const effects = yield* f.sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id='cancel-session-restart' AND effect_type='provider-turn.interrupt'`;
          const target = decodeEffect(effects[0]!.payload_json);
          assert.equal(target.type, "provider-turn.interrupt");
          if (target.type !== "provider-turn.interrupt") return;
          assert.equal(target.providerSessionId, oldThread.providerSessionId);
          assert.equal(target.replacementProviderSessionId, newThread.providerSessionId);
          assert.equal((yield* occupied(f)).length, 1);
          const stopped = yield* f.orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (e) =>
                e.type === "provider-turn.updated" &&
                e.payload.runAttemptId === first.activeAttemptId &&
                e.payload.status === "interrupted" &&
                e.payload.terminationConfirmed === true,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* f.worker.drain();
          assert.equal(interruptCount(), 1);
          yield* Fiber.join(stopped);
          assert.equal((yield* occupied(f)).length, 0);
          assert.equal((yield* Ref.get(f.started)).length, 1);
          assert.equal(yield* Ref.get(f.opened), 1);
          assert.equal((yield* admissions(f)).length, 1);
          yield* f.rebuild;
          yield* f.worker.drain();
          assert.equal(interruptCount(), 1);
          assert.equal((yield* Ref.get(f.started)).length, 1);
        }),
      { restartSession: true },
    ),
);

it.live("a stale guarded Stop cannot flag the replacement attempt's occupied lease", () =>
  withHeld(({ f, first }) =>
    Effect.gen(function* () {
      yield* f.dispatch(
        send(first.threadId, "guarded-replacement", {
          type: "restart_active",
          targetRunId: first.id,
          targetAttemptId: first.activeAttemptId!,
        }),
        agentsCreationActor,
      );
      const replacement = (yield* f.orchestrator.getThreadProjection(first.threadId)).runs[0]!;
      assert.notEqual(replacement.activeAttemptId, first.activeAttemptId);
      const rejected = yield* Effect.exit(
        f.dispatch(
          {
            type: "run.interrupt",
            commandId: CommandId.make("stale-guarded-stop"),
            threadId: first.threadId,
            runId: first.id,
            expectedAttemptId: first.activeAttemptId!,
          },
          agentsCreationActor,
        ),
      );
      const rows = yield* f.sql<{
        interrupt_requested: number;
      }>`SELECT interrupt_requested FROM base3_capacity_leases WHERE released_at IS NULL AND thread_id=${first.threadId}`;
      assert.deepEqual(
        rows.map((row) => row.interrupt_requested),
        [0],
      );
      assert.equal(rejected._tag, "Failure");
      yield* f.worker.drain();
      assert.equal((yield* Ref.get(f.started)).length, 2);
    }),
  ),
);
it.live("guarded pre-start Stop cleans up only the committed retired native attempt", () =>
  withHeld(({ f, first, interruptCount }) =>
    Effect.gen(function* () {
      yield* f.dispatch(
        send(first.threadId, "guarded-prestart-replacement", {
          type: "restart_active",
          targetRunId: first.id,
          targetAttemptId: first.activeAttemptId!,
        }),
        agentsCreationActor,
      );
      const replacement = (yield* f.orchestrator.getThreadProjection(first.threadId)).runs[0]!;
      const stop = {
        type: "run.interrupt" as const,
        commandId: CommandId.make("guarded-prestart-stop"),
        threadId: first.threadId,
        runId: first.id,
        expectedAttemptId: replacement.activeAttemptId!,
        holdQueue: true,
      };
      yield* f.dispatch(stop, agentsCreationActor);
      const terminal = yield* f.orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.runAttemptId === first.activeAttemptId &&
            event.payload.terminationConfirmed === true,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* f.worker.drain();
      assert.equal(interruptCount(), 1);
      yield* Fiber.join(terminal);
      yield* f.worker.drain();
      yield* f.dispatch(stop, agentsCreationActor);
      yield* f.worker.drain();
      assert.equal(interruptCount(), 1);
      const projection = yield* f.orchestrator.getThreadProjection(first.threadId);
      assert.equal(projection.runs[0]!.status, "interrupted");
      assert.equal(projection.runs[0]!.activeAttemptId, replacement.activeAttemptId);
      assert.equal((yield* Ref.get(f.started)).length, 1);
    }),
  ),
);

it.live("a matching guarded Stop flags only its own bound or matching-message lease", () =>
  withHeld(({ f, first, interruptCount }) =>
    Effect.gen(function* () {
      yield* f.sql`INSERT INTO base3_capacity_leases (lease_id,environment_id,thread_id,message_id,run_id,workload_class,status,interrupt_requested,disconnect_unconfirmed,created_at)
      VALUES ('unrelated-unbound','environment-a',${first.threadId},'unrelated-message',NULL,'foreground-turn','active',0,0,'2026-10-19T00:00:00.000Z')`;
      yield* f.dispatch(
        {
          type: "run.interrupt",
          commandId: CommandId.make("matching-lease-stop"),
          threadId: first.threadId,
          runId: first.id,
          expectedAttemptId: first.activeAttemptId!,
          holdQueue: true,
        },
        agentsCreationActor,
      );
      const before = yield* f.sql<{
        lease_id: string;
        interrupt_requested: number;
      }>`SELECT lease_id, interrupt_requested FROM base3_capacity_leases WHERE thread_id=${first.threadId}`;
      assert.equal(
        before.find((row) => row.lease_id === "unrelated-unbound")!.interrupt_requested,
        0,
      );
      assert.isTrue(
        before.some((row) => row.lease_id !== "unrelated-unbound" && row.interrupt_requested === 1),
      );
      yield* f.worker.drain();
      assert.equal(interruptCount(), 1);
      const after = yield* f.sql<{
        interrupt_requested: number;
      }>`SELECT interrupt_requested FROM base3_capacity_leases WHERE lease_id='unrelated-unbound'`;
      assert.equal(after[0]!.interrupt_requested, 0);
    }),
  ),
);
