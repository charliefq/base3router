// Disposable SQLite files live under the OS temp directory.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  measureTaskCohort,
  mergeTaskUsage,
  summarizeTaskUsage,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type TaskUsageSummary,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import { nextTaskContractThread } from "./TaskContract.ts";
import {
  assertCanReadTaskUsage,
  contributionFromTurn,
  readTaskUsage,
  readTaskUsageCohort,
  recordTaskUsage,
} from "./TaskUsageAccounting.ts";

const CODEX = ProviderDriverKind.make("codex");
const PROVIDER_A = ProviderInstanceId.make("codex-a");
const PROVIDER_B = ProviderInstanceId.make("codex-b");
const SECRET_PROMPT = "SECRET_PROMPT_SHOULD_NOT_BE_STORED";
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const fields = {
  goal: "Ship the slice",
  redirect: "Pause when the plan changes",
  acceptance: "The focused tests pass",
  brake: { maxProviderStarts: 20, stopConditions: "Stop after the start budget" },
};

function testLayer(dbPath: string) {
  const databaseLayer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(databaseLayer),
  );
  const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, databaseLayer)));
  return Layer.mergeAll(
    stores,
    sink,
    IdAllocator.layer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(Layer.mergeAll(stores, sink, IdAllocator.layer)),
    ),
  );
}

function governedThread(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly rootThreadId: ThreadId;
  readonly parentThreadId?: ThreadId;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: input.projectId,
    title: "Governed task",
    providerInstanceId: PROVIDER_A,
    modelSelection: { instanceId: PROVIDER_A, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: input.parentThreadId ?? null,
      relationshipToParent: input.parentThreadId === undefined ? null : "subagent",
      rootThreadId: input.rootThreadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    taskGovernance: "required",
    taskContract: { revision: 1, ...fields },
    taskContractPhase: "active",
    taskAcceptedRevision: null,
  };
}

const reported = (summary: TaskUsageSummary) => summary.reported;

function turnTokenUsage(usage: {
  readonly usageStatus: "complete" | "partial" | "unavailable";
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}): TurnTokenUsage {
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents: false,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
  if (usage.usageStatus === "complete") {
    return {
      ...common,
      usageStatus: "complete",
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  }
  return {
    ...common,
    usageStatus: usage.usageStatus,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  };
}

it.effect("requires orchestration:read and keeps a missing report unknown", () =>
  Effect.gen(function* () {
    const denied = yield* Effect.flip(assertCanReadTaskUsage([AuthOrchestrationOperateScope]));
    expect(isEnvironmentAuthorizationError(denied)).toBe(true);
    expect(denied.requiredScope).toBe(AuthOrchestrationReadScope);
    yield* assertCanReadTaskUsage([AuthOrchestrationReadScope]);
    const anonymous = yield* Effect.flip(assertCanReadTaskUsage(undefined));
    expect(anonymous.requiredScope).toBe(AuthOrchestrationReadScope);

    const ignored = contributionFromTurn({
      reportedCostUsd: Number.NaN,
      turnTokenUsage: {
        usageStatus: "complete",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: 50,
        cachedInputTokens: 80,
        cacheCreationTokens: 40,
        outputTokens: 10,
        reasoningTokens: 30,
      },
    });
    expect(ignored.inputTokens).toBe(50);
    expect(ignored.cachedInputTokens).toBe(50);
    expect(ignored.cacheCreationTokens).toBe(0);
    expect(ignored.reasoningTokens).toBe(10);
    expect(ignored.reportedCostUsd).toBe(null);
    expect(
      contributionFromTurn({
        turnTokenUsage: {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        },
      }).inputTokens,
    ).toBe(null);

    const replaced = mergeTaskUsage(
      {
        ...ignored,
        usageStatus: "complete",
        cachedInputTokens: 10,
        cacheCreationTokens: 0,
        reasoningTokens: 1,
        reportedCostUsd: 2,
      },
      {
        ...ignored,
        inputTokens: 140,
        cachedInputTokens: 50,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 6,
        reportedCostUsd: 2,
        usageStatus: "complete",
      },
      "snapshot",
    );
    expect(replaced.inputTokens).toBe(140);
    const added = mergeTaskUsage(
      replaced,
      {
        inputTokens: 5,
        cachedInputTokens: 1,
        cacheCreationTokens: 0,
        outputTokens: 2,
        reasoningTokens: 1,
        reportedCostUsd: 1,
        usageStatus: "complete",
      },
      "incremental",
    );
    expect(added.inputTokens).toBe(145);
    const kept = mergeTaskUsage(
      added,
      {
        inputTokens: null,
        cachedInputTokens: null,
        cacheCreationTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        reportedCostUsd: null,
        usageStatus: "unavailable",
      },
      "snapshot",
    );
    expect(kept.inputTokens).toBe(145);

    const rejected = summarizeTaskUsage({
      rootThreadId: ThreadId.make("root-rejected"),
      contractRevision: 1,
      acceptedRevision: null,
      phase: "redirected",
      attempts: [
        {
          providerTurnId: "turn",
          threadId: ThreadId.make("root-rejected"),
          runId: "run",
          messageId: "message",
          contractRevision: 1,
          status: "completed",
          role: "primary",
          usageStatus: "complete",
          basis: "snapshot",
          inputTokens: 7,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 4,
          reasoningTokens: 0,
          reportedCostUsd: 2,
        },
      ],
    });
    const undefinedRatio = measureTaskCohort([rejected]);
    expect(undefinedRatio.accepted).toBe(0);
    expect(undefinedRatio.reported.inputTokens).toBe(7);
    expect(undefinedRatio.perAccepted.defined).toBe(false);
    expect(undefinedRatio.perAccepted.reportedInputTokens).toBe(null);
    expect(undefinedRatio.perAccepted.inputTokens).toBe(null);
  }),
);

it.effect("accounts a synthetic cohort through provider ingestion", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "task-usage-"));
    const dbPath = NodePath.join(directory, "statev2.sqlite");
    const layer = testLayer(dbPath);
    const observed = yield* Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-usage");
      const roots = {
        a: ThreadId.make("thread-accepted"),
        b: ThreadId.make("thread-parent"),
        child: ThreadId.make("thread-child"),
        c: ThreadId.make("thread-failover"),
        d: ThreadId.make("thread-rejected"),
        e: ThreadId.make("thread-missing"),
      };
      const writeThread = (thread: OrchestrationV2AppThread) =>
        eventSink.write({
          events: [
            {
              id: EventId.make(`event:thread:${thread.id}`),
              type: "thread.created" as const,
              threadId: thread.id,
              occurredAt: now,
              payload: thread,
            },
          ],
        });
      yield* writeThread(
        governedThread({ now, threadId: roots.a, projectId, rootThreadId: roots.a }),
      );
      yield* writeThread(
        governedThread({ now, threadId: roots.b, projectId, rootThreadId: roots.b }),
      );
      yield* writeThread(
        governedThread({
          now,
          threadId: roots.child,
          projectId,
          rootThreadId: roots.b,
          parentThreadId: roots.b,
        }),
      );
      yield* writeThread(
        governedThread({ now, threadId: roots.c, projectId, rootThreadId: roots.c }),
      );
      yield* writeThread(
        governedThread({ now, threadId: roots.d, projectId, rootThreadId: roots.d }),
      );
      yield* writeThread(
        governedThread({ now, threadId: roots.e, projectId, rootThreadId: roots.e }),
      );

      const writeMessage = (threadId: ThreadId, runId: RunId, messageId: MessageId) =>
        eventSink.write({
          events: [
            {
              id: EventId.make(`event:message:${messageId}`),
              type: "message.updated" as const,
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                text: SECRET_PROMPT,
                attachments: [],
                streaming: false,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });

      const ingest = (input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly turnId: string;
        readonly provider?: ProviderInstanceId;
        readonly status?: "completed" | "failed" | "cancelled";
        readonly usage?: {
          readonly usageStatus: "complete" | "partial" | "unavailable";
          readonly inputTokens?: number;
          readonly cachedInputTokens?: number;
          readonly cacheCreationTokens?: number;
          readonly outputTokens?: number;
          readonly reasoningTokens?: number;
        };
        readonly cost?: number;
        readonly basis?: "snapshot" | "incremental";
        readonly contextTokens?: number;
      }) =>
        Effect.gen(function* () {
          const provider = input.provider ?? PROVIDER_A;
          const sessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: provider,
            threadId: input.threadId,
          });
          const stored = yield* ingestor.ingestNormalized({
            providerSessionId: sessionId,
            providerInstanceId: provider,
            threadId: input.threadId,
            runId: input.runId,
            event: {
              type: "provider_turn.updated" as const,
              driver: CODEX,
              threadId: input.threadId,
              providerTurn: {
                id: ProviderTurnId.make(input.turnId),
                providerThreadId: idAllocator.derive.providerThread({
                  driver: CODEX,
                  nativeThreadId: input.turnId,
                }),
                nodeId: NodeId.make(`node:${input.turnId}`),
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: input.status ?? "completed",
                startedAt: now,
                completedAt: now,
                ...(input.contextTokens === undefined
                  ? {}
                  : {
                      tokenUsage: {
                        usedTokens: input.contextTokens,
                        inputTokens: input.contextTokens,
                        outputTokens: input.contextTokens,
                        updatedAt: DateTime.formatIso(now),
                      },
                    }),
                ...(input.usage === undefined
                  ? {}
                  : { turnTokenUsage: turnTokenUsage(input.usage) }),
                ...(input.cost === undefined ? {} : { reportedCostUsd: input.cost }),
                ...(input.basis === undefined ? {} : { usageAccounting: input.basis }),
              },
            },
          });
          return stored;
        });

      const runA = RunId.make("run-a");
      const messageA = MessageId.make("message-a");
      yield* writeMessage(roots.a, runA, messageA);
      const first = yield* ingest({
        threadId: roots.a,
        runId: runA,
        turnId: "turn-a",
        cost: 2,
        contextTokens: 9000,
        usage: {
          usageStatus: "complete",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      });
      const turnEvent = first.find(
        (
          stored,
        ): stored is typeof stored & {
          event: Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }>;
        } => stored.event.type === "provider-turn.updated",
      );
      if (turnEvent === undefined) return yield* Effect.die("missing provider turn event");
      yield* recordTaskUsage("unscoped", turnEvent.event);
      yield* ingest({
        threadId: roots.a,
        runId: runA,
        turnId: "turn-a",
        cost: 2,
        usage: {
          usageStatus: "complete",
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      });
      yield* ingest({
        threadId: roots.a,
        runId: runA,
        turnId: "turn-a",
        cost: 2,
        basis: "snapshot",
        usage: {
          usageStatus: "complete",
          inputTokens: 140,
          cachedInputTokens: 50,
          cacheCreationTokens: 10,
          outputTokens: 25,
          reasoningTokens: 6,
        },
      });
      yield* ingest({
        threadId: roots.a,
        runId: runA,
        turnId: "turn-a",
        cost: 1,
        basis: "incremental",
        usage: {
          usageStatus: "complete",
          inputTokens: 5,
          cachedInputTokens: 1,
          cacheCreationTokens: 0,
          outputTokens: 2,
          reasoningTokens: 1,
        },
      });

      const runB = RunId.make("run-b");
      const runChild = RunId.make("run-child");
      yield* writeMessage(roots.b, runB, MessageId.make("message-b"));
      yield* writeMessage(roots.child, runChild, MessageId.make("message-child"));
      yield* ingest({
        threadId: roots.b,
        runId: runB,
        turnId: "turn-b",
        cost: 4,
        usage: {
          usageStatus: "complete",
          inputTokens: 50,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
      });
      yield* ingest({
        threadId: roots.child,
        runId: runChild,
        turnId: "turn-child",
        cost: 1,
        usage: {
          usageStatus: "complete",
          inputTokens: 30,
          cachedInputTokens: 5,
          cacheCreationTokens: 0,
          outputTokens: 8,
          reasoningTokens: 2,
        },
      });

      const runC = RunId.make("run-c");
      yield* writeMessage(roots.c, runC, MessageId.make("message-c"));
      yield* ingest({
        threadId: roots.c,
        runId: runC,
        turnId: "turn-c-primary",
        status: "failed",
        cost: 1,
        usage: {
          usageStatus: "complete",
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
      });
      yield* ingest({
        threadId: roots.c,
        runId: runC,
        turnId: "turn-c-retry",
        status: "failed",
        cost: 1,
        usage: {
          usageStatus: "complete",
          inputTokens: 12,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
        },
      });
      yield* ingest({
        threadId: roots.c,
        runId: runC,
        turnId: "turn-c-failover",
        provider: PROVIDER_B,
        status: "completed",
        cost: 1,
        usage: {
          usageStatus: "complete",
          inputTokens: 15,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 3,
          reasoningTokens: 0,
        },
      });

      const runD = RunId.make("run-d");
      yield* writeMessage(roots.d, runD, MessageId.make("message-d"));
      yield* ingest({
        threadId: roots.d,
        runId: runD,
        turnId: "turn-d",
        cost: 2,
        usage: {
          usageStatus: "complete",
          inputTokens: 7,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 4,
          reasoningTokens: 0,
        },
      });

      const runE = RunId.make("run-e");
      yield* writeMessage(roots.e, runE, MessageId.make("message-e"));
      yield* ingest({
        threadId: roots.e,
        runId: runE,
        turnId: "turn-e-cancelled",
        status: "cancelled",
        usage: { usageStatus: "unavailable" },
      });
      yield* ingest({
        threadId: roots.e,
        runId: runE,
        turnId: "turn-e-partial",
        status: "completed",
        usage: { usageStatus: "partial", outputTokens: 9 },
      });

      const accept = (thread: OrchestrationV2AppThread) => {
        const decided = nextTaskContractThread({
          thread,
          actorId: "user-1",
          now,
          command: { type: "thread.task-contract.accept", revision: 1 },
        });
        if ("error" in decided) return Effect.die(decided.error);
        return eventSink.write({
          events: [
            {
              id: EventId.make(`event:accept:${thread.id}`),
              type: "thread.metadata-updated" as const,
              threadId: thread.id,
              occurredAt: now,
              payload: decided.thread,
            },
          ],
        });
      };
      yield* accept(governedThread({ now, threadId: roots.a, projectId, rootThreadId: roots.a }));
      yield* accept(governedThread({ now, threadId: roots.b, projectId, rootThreadId: roots.b }));
      const redirected = nextTaskContractThread({
        thread: governedThread({ now, threadId: roots.d, projectId, rootThreadId: roots.d }),
        actorId: "user-1",
        now,
        command: { type: "thread.task-contract.redirect", revision: 1 },
      });
      if ("error" in redirected) return yield* Effect.die(redirected.error);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:redirect:d"),
            type: "thread.metadata-updated",
            threadId: roots.d,
            occurredAt: now,
            payload: redirected.thread,
          },
        ],
      });

      yield* recordTaskUsage("other-env", {
        ...turnEvent.event,
        id: EventId.make("event:other-env"),
        payload: {
          ...turnEvent.event.payload,
          id: ProviderTurnId.make("turn-other-env"),
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 999,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 999,
            reasoningTokens: 0,
          },
          reportedCostUsd: 999,
        },
      });

      const cohort = yield* readTaskUsageCohort("unscoped", [
        roots.a,
        roots.b,
        roots.child,
        roots.c,
        roots.d,
        roots.e,
      ]);
      const isolated = yield* readTaskUsage("other-env", roots.a);
      const childView = yield* readTaskUsage("unscoped", roots.child);
      const rows = yield* sql<{ readonly message_id: string | null }>`
        SELECT message_id, input_tokens, root_thread_id FROM task_usage_attempts
      `;
      const events = yield* sql`SELECT event_id, provider_turn_id FROM task_usage_events`;
      expect(JSON.stringify({ rows, events })).not.toContain(SECRET_PROMPT);
      expect(rows.some((row) => row.message_id === "message-a")).toBe(true);
      expect(isolated.reported.inputTokens).toBe(999);
      expect(childView.rootThreadId).toBe(roots.b);
      expect(childView.acceptance).toBe("accepted");
      expect(childView.childCount).toBe(1);
      return { cohort, childView, roots };
    }).pipe(Effect.provide(layer));

    const reopened = yield* readTaskUsageCohort("unscoped", [
      ThreadId.make("thread-accepted"),
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-failover"),
      ThreadId.make("thread-rejected"),
      ThreadId.make("thread-missing"),
    ]).pipe(Effect.provide(testLayer(dbPath)));
    const repeated = yield* readTaskUsageCohort("unscoped", [
      ThreadId.make("thread-accepted"),
      ThreadId.make("thread-parent"),
      ThreadId.make("thread-failover"),
      ThreadId.make("thread-rejected"),
      ThreadId.make("thread-missing"),
    ]).pipe(Effect.provide(testLayer(dbPath)));

    const expected = {
      attempted: 5,
      accepted: 2,
      rejected: 1,
      unfinished: 2,
      coverage: "partial" as const,
      reported: {
        inputTokens: 269,
        cachedInputTokens: 56,
        cacheCreationTokens: 10,
        outputTokens: 64,
        reasoningTokens: 9,
        reportedCostUsd: 13,
      },
      reportedBillableTokens: 324,
      perAccepted: {
        defined: true,
        reportedInputTokens: 134.5,
        reportedOutputTokens: 32,
        reportedCachedInputTokens: 28,
        reportedCacheCreationTokens: 5,
        reportedReasoningTokens: 4.5,
        reportedCostUsdKnown: 6.5,
        reportedBillableTokens: 162,
        inputTokens: null,
        outputTokens: null,
        reportedCostUsd: null,
      },
    };
    expect(observed.cohort.attempted).toBe(expected.attempted);
    expect(observed.cohort.accepted).toBe(expected.accepted);
    expect(observed.cohort.rejected).toBe(expected.rejected);
    expect(observed.cohort.unfinished).toBe(expected.unfinished);
    expect(observed.cohort.coverage).toBe(expected.coverage);
    expect(observed.cohort.totals.inputTokens).toBe(null);
    expect(observed.cohort.totals.reportedCostUsd).toBe(null);
    expect(observed.cohort.reported).toEqual(expected.reported);
    expect(observed.cohort.reportedBillableTokens).toBe(expected.reportedBillableTokens);
    expect(observed.cohort.perAccepted.defined).toBe(true);
    expect(observed.cohort.perAccepted.inputTokens).toBe(null);
    expect(observed.cohort.perAccepted.reportedInputTokens).toBe(134.5);
    expect(observed.cohort.perAccepted.reportedOutputTokens).toBe(32);
    expect(observed.cohort.perAccepted.reportedCachedInputTokens).toBe(28);
    expect(observed.cohort.perAccepted.reportedCacheCreationTokens).toBe(5);
    expect(observed.cohort.perAccepted.reportedReasoningTokens).toBe(4.5);
    expect(observed.cohort.perAccepted.reportedCostUsdKnown).toBe(6.5);
    expect(observed.cohort.perAccepted.reportedBillableTokens).toBe(162);
    expect(observed.cohort.perAccepted.reportedCostUsd).toBe(null);
    expect(reopened).toEqual(observed.cohort);
    expect(repeated).toEqual(observed.cohort);
    expect(observed.childView.reported.inputTokens).toBe(80);

    const accepted = yield* readTaskUsage("unscoped", ThreadId.make("thread-accepted")).pipe(
      Effect.provide(testLayer(dbPath)),
    );
    expect(accepted.acceptance).toBe("accepted");
    expect(accepted.providerCompletionIsAcceptance).toBe(false);
    expect(accepted.attempts).toBe(1);
    expect(accepted.childCount).toBe(0);
    expect(reported(accepted)).toEqual({
      inputTokens: 145,
      cachedInputTokens: 51,
      cacheCreationTokens: 10,
      outputTokens: 27,
      reasoningTokens: 7,
      reportedCostUsd: 3,
    });
    expect(accepted.totalsComplete).toBe(true);
    const failover = yield* readTaskUsage("unscoped", ThreadId.make("thread-failover")).pipe(
      Effect.provide(testLayer(dbPath)),
    );
    expect(failover.acceptance).toBe("unfinished");
    expect(failover.primaryAttempts).toBe(1);
    expect(failover.retryAttempts).toBe(1);
    expect(failover.failoverAttempts).toBe(1);
    expect(failover.failedAttempts).toBe(2);
    expect(failover.reported.inputTokens).toBe(37);
    const missing = yield* readTaskUsage("unscoped", ThreadId.make("thread-missing")).pipe(
      Effect.provide(testLayer(dbPath)),
    );
    expect(missing.attempts).toBe(2);
    expect(missing.cancelledAttempts).toBe(1);
    expect(missing.missingUsageAttempts).toBe(2);
    expect(missing.missingCostAttempts).toBe(2);
    expect(missing.reported.inputTokens).toBe(null);
    expect(missing.reported.outputTokens).toBe(9);
    expect(missing.reported.reportedCostUsd).toBe(null);
    expect(missing.totals.outputTokens).toBe(null);
    expect(missing.totalsComplete).toBe(false);

    const sha = NodeChildProcess.execSync("git rev-parse HEAD", { cwd: "/workspace" })
      .toString()
      .trim();
    const report = {
      label: "SYNTHETIC_ACCOUNTING_VERIFIED",
      synthetic: true,
      notModelPerformance: true,
      notAutoVsManualComparison: true,
      baselineSha: "55a1ea4f496eadea161c0e88822b375e42a0f127",
      commitSha: sha,
      definitions: {
        attempt: "One provider turn on a governed task tree.",
        snapshot:
          "turnTokenUsage replaces the same turn. Input includes cache. Output includes reasoning.",
        incremental: "A later incremental report adds to that turn.",
        contextWindow: "tokenUsage.usedTokens is not task consumption.",
        missing: "Unknown stays null. It is not stored or displayed as zero.",
        cost: "Provider-reported cost only. No price table.",
        acceptance:
          "Human accept of the current contract revision. Provider completion is not acceptance.",
        perAccepted:
          "All cohort consumption divided by accepted tasks. Undefined when none are accepted.",
        partial: "Any missing usage category or cost makes the total partial.",
      },
      expected,
      observed: {
        attempted: observed.cohort.attempted,
        accepted: observed.cohort.accepted,
        rejected: observed.cohort.rejected,
        unfinished: observed.cohort.unfinished,
        coverage: observed.cohort.coverage,
        reported: observed.cohort.reported,
        reportedBillableTokens: observed.cohort.reportedBillableTokens,
        perAccepted: {
          defined: observed.cohort.perAccepted.defined,
          reportedInputTokens: observed.cohort.perAccepted.reportedInputTokens,
          reportedOutputTokens: observed.cohort.perAccepted.reportedOutputTokens,
          reportedCachedInputTokens: observed.cohort.perAccepted.reportedCachedInputTokens,
          reportedCacheCreationTokens: observed.cohort.perAccepted.reportedCacheCreationTokens,
          reportedReasoningTokens: observed.cohort.perAccepted.reportedReasoningTokens,
          reportedCostUsdKnown: observed.cohort.perAccepted.reportedCostUsdKnown,
          reportedBillableTokens: observed.cohort.perAccepted.reportedBillableTokens,
          inputTokens: observed.cohort.perAccepted.inputTokens,
          outputTokens: observed.cohort.perAccepted.outputTokens,
          reportedCostUsd: observed.cohort.perAccepted.reportedCostUsd,
        },
      },
    };
    expect(report.observed).toEqual(report.expected);
    NodeFS.mkdirSync("/opt/cursor/artifacts", { recursive: true });
    NodeFS.writeFileSync(
      "/opt/cursor/artifacts/synthetic-accounting-report.json",
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }),
);
