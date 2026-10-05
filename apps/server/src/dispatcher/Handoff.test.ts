import {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  TaskHandoffId,
  ThreadId,
  TurnId,
  DispatcherTaskRouteBinding,
  DispatcherHandoffPacket,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  bindTaskHandoffTurnStart,
  markTaskHandoffContinued,
  markTaskHandoffFailed,
  persistTaskHandoff,
  previewTaskHandoff,
  readLatestTaskHandoff,
  readTaskHandoffByDestinationMessage,
} from "./Handoff.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const sourceTurnId = TurnId.make("turn-1");
const sourceMessageId = MessageId.make("message-1");
const sourceInstanceId = ProviderInstanceId.make("codex-work");
const targetInstanceId = ProviderInstanceId.make("claude-work");
const target = { instanceId: targetInstanceId, model: "claude-sonnet" } as const;
const now = "2026-09-26T12:00:00.000Z";
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const CheckpointFile = Schema.Struct({
  path: Schema.String,
  kind: Schema.optional(Schema.String),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
});
const encodeCheckpointFiles = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(CheckpointFile)),
);
const encodeRouteBinding = Schema.encodeSync(Schema.fromJsonString(DispatcherTaskRouteBinding));
const encodeHandoffPacket = Schema.encodeSync(Schema.fromJsonString(DispatcherHandoffPacket));
const decodeRouteBinding = Schema.decodeSync(Schema.fromJsonString(DispatcherTaskRouteBinding));

const sourceBinding: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: sourceInstanceId, model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: sourceInstanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: targetInstanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [{ slug: "claude-sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

const git = {
  statusDetailsLocal: () =>
    Effect.succeed({
      isRepo: true,
      hasOriginRemote: true,
      isDefaultBranch: false,
      branch: "feature/handoff",
      upstreamRef: null,
      hasWorkingTreeChanges: false,
      workingTree: [],
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
    }),
  resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
} as unknown as GitVcsDriver.GitVcsDriver["Service"];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at,
      default_model_selection_json, deleted_at
    ) VALUES ('project-1', 'Project', '/workspace/project', '[]', ${now}, ${now}, NULL, NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, branch, worktree_path,
      latest_turn_id, created_at, updated_at, deleted_at
    ) VALUES (
      ${threadId}, 'project-1', 'Task',
      ${encodeModelSelection({ instanceId: sourceInstanceId, model: "gpt-5.4" })},
      'feature/handoff', NULL, ${sourceTurnId}, ${now}, ${now}, NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (${sourceMessageId}, ${threadId}, ${sourceTurnId}, 'user', 'Build the feature', 0, ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    ) VALUES (
      'assistant-1', ${threadId}, ${sourceTurnId}, 'assistant',
      ${`## Completed work

Implemented [handoff](/workspace/project/src/handoff.ts). A private file at /private/secret was not used.

## Remaining steps

Add the destination validation tests.

## Test results

The focused handoff test passed.`},
      0, ${now}, ${now}
    )
  `;
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, pending_message_id, assistant_message_id, state,
      requested_at, started_at, completed_at, checkpoint_files_json
    ) VALUES (
      ${threadId}, ${sourceTurnId}, ${sourceMessageId}, 'assistant-1', 'completed',
      ${now}, ${now}, ${now},
      ${encodeCheckpointFiles([
        { path: "src/handoff.ts", kind: "modified", additions: 2, deletions: 0 },
        { path: "/private/secret", kind: "modified", additions: 1, deletions: 0 },
      ])}
    )
  `;
  yield* sql`
    INSERT INTO projection_dispatcher_task_routes (thread_id, message_id, binding_json, created_at)
    VALUES (${threadId}, ${sourceMessageId}, ${encodeRouteBinding(sourceBinding)}, ${now})
  `;
});

const preview = (providerSnapshots = providers) =>
  previewTaskHandoff({
    enabled: true,
    handoffId: TaskHandoffId.make("handoff-1"),
    request: { environmentId, threadId, sourceTurnId, target },
    environmentId,
    providers: providerSnapshots,
    environmentDefaultModelSelection: null,
    git,
  });

describe("explicit task handoff", () => {
  it.effect("builds bounded verified context and validates only the explicit destination", () =>
    Effect.gen(function* () {
      yield* seed;
      const result = yield* preview();
      expect(result.availability).toEqual({ status: "ready" });
      expect(result.route?.candidates).toHaveLength(1);
      expect(result.route?.selected?.target).toEqual(target);
      expect(result.packet).toMatchObject({
        originalObjective: "Build the feature",
        latestUserInstruction: "Build the feature",
        branch: "feature/handoff",
        commit: "abc123",
        completedWork:
          "Implemented [handoff](src/handoff.ts). A private file at [path omitted] was not used.",
        remainingSteps: "Add the destination validation tests.",
        testResults: "The focused handoff test passed.",
      });
      expect(result.packet.references).toContainEqual({ kind: "file", value: "src/handoff.ts" });
      expect(result.packetText).not.toContain("/private/secret");
      expect(result.packetText).not.toContain("/workspace/project");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("leaves unverified summary fields unknown when explicit headings are absent", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_messages SET text = 'Phase A is done.' WHERE message_id = 'assistant-1'`;
      const result = yield* preview();
      expect(result.packet).toMatchObject({
        completedWork: "Unknown",
        remainingSteps: "Unknown",
        testResults: "Unknown",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("redacts sensitive values from projected summary sections", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_thread_messages
        SET text = ${`## Completed work

Used Bearer secret-bearer-value and sk-secretvalue1234 while reviewing https://example.test/private.

The runner reported API_TOKEN=secret-environment-value before cleanup.

## Remaining steps

Inspect /home/example/private and [the workspace file](/workspace/project/src/handoff.ts).

## Test results

Unknown`}
        WHERE message_id = 'assistant-1'
      `;
      const result = yield* preview();
      const serialized = encodeHandoffPacket(result.packet);
      expect(serialized).not.toContain("secret-bearer-value");
      expect(serialized).not.toContain("sk-secretvalue1234");
      expect(serialized).not.toContain("example.test");
      expect(serialized).not.toContain("secret-environment-value");
      expect(serialized).not.toContain("/home/example/private");
      expect(result.packet.completedWork).toContain("[credential omitted]");
      expect(result.packet.completedWork).toContain("[link omitted]");
      expect(result.packet.completedWork).toContain("[environment value omitted]");
      expect(result.packet.remainingSteps).toContain("[path omitted]");
      expect(result.packet.remainingSteps).toContain("[the workspace file](src/handoff.ts)");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "reports an installed/authenticated runner requirement instead of treating a model as access",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const unavailableProviders = providers.map((provider) =>
          provider.instanceId === targetInstanceId ? { ...provider, installed: false } : provider,
        );
        const result = yield* preview(unavailableProviders);
        expect(result.availability).toEqual({
          status: "unavailable",
          reasonCode: "TARGET_RUNNER_UNAVAILABLE",
          reason: "The selected provider runner is not installed on this environment.",
        });
        expect(result.route?.selected).toBeNull();
        expect(result.route?.candidates).toHaveLength(1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "persists one idempotent source-to-destination link and preserves the source binding",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const handoffId = TaskHandoffId.make("handoff-1");
        yield* persistTaskHandoff({
          handoffId,
          threadId,
          sourceTurnId,
          destinationMessageId: MessageId.make("message-2"),
          target,
          createdAt: now,
        });
        yield* persistTaskHandoff({
          handoffId: TaskHandoffId.make("duplicate"),
          threadId,
          sourceTurnId,
          destinationMessageId: MessageId.make("message-3"),
          target,
          createdAt: now,
        });
        yield* markTaskHandoffContinued({
          threadId,
          destinationMessageId: MessageId.make("message-2"),
          destinationTurnId: TurnId.make("turn-2"),
          updatedAt: now,
        });
        const stored = yield* readLatestTaskHandoff(threadId);
        expect(stored).toMatchObject({
          handoffId,
          sourceTurnId,
          destinationMessageId: "message-2",
          destinationTurnId: "turn-2",
          status: "continued",
        });
        expect(
          yield* readTaskHandoffByDestinationMessage({
            threadId,
            destinationMessageId: MessageId.make("message-2"),
          }),
        ).toEqual(stored);
        expect(
          yield* readTaskHandoffByDestinationMessage({
            threadId,
            destinationMessageId: MessageId.make("message-missing"),
          }),
        ).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        const source = yield* sql<{ readonly binding: string }>`
        SELECT binding_json AS binding
        FROM projection_dispatcher_task_routes
        WHERE thread_id = ${threadId} AND message_id = ${sourceMessageId}
      `;
        assert.deepStrictEqual(decodeRouteBinding(source[0]!.binding), sourceBinding);
        assert.equal((yield* sql`SELECT * FROM projection_task_handoffs`).length, 1);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("binds the reviewed packet to the exact route and rejects a repeated source", () =>
    Effect.gen(function* () {
      yield* seed;
      const handoffId = TaskHandoffId.make("handoff-1");
      const command = {
        type: "thread.turn.start" as const,
        commandId: "command-1" as never,
        threadId,
        message: {
          messageId: MessageId.make("message-2"),
          role: "user" as const,
          text: "client placeholder",
          attachments: [],
        },
        modelSelection: target,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        handoffRequest: { handoffId, sourceTurnId, target, packetText: "Reviewed packet" },
        createdAt: now,
      };
      const bound = yield* bindTaskHandoffTurnStart(command, {
        enabled: true,
        environmentId,
        providers,
        environmentDefaultModelSelection: null,
      });
      expect(bound).toMatchObject({
        message: { text: "Reviewed packet" },
        modelSelection: target,
        routeBinding: { target, fallbackIndex: 0 },
        handoff: { handoffId, sourceTurnId, target },
      });
      yield* persistTaskHandoff({
        handoffId,
        threadId,
        sourceTurnId,
        destinationMessageId: MessageId.make("message-2"),
        target,
        createdAt: now,
      });
      const repeated = yield* Effect.exit(
        bindTaskHandoffTurnStart(command, {
          enabled: true,
          environmentId,
          providers,
          environmentDefaultModelSelection: null,
        }),
      );
      expect(repeated._tag).toBe("Failure");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("records a bounded server-owned failure without changing the selected target", () =>
    Effect.gen(function* () {
      yield* seed;
      const destinationMessageId = MessageId.make("message-failed");
      yield* persistTaskHandoff({
        handoffId: TaskHandoffId.make("handoff-failed"),
        threadId,
        sourceTurnId,
        destinationMessageId,
        target,
        createdAt: now,
      });
      yield* markTaskHandoffFailed({ threadId, destinationMessageId, updatedAt: now });

      expect(
        yield* readTaskHandoffByDestinationMessage({ threadId, destinationMessageId }),
      ).toMatchObject({
        target,
        status: "failed",
        failureReason: "The selected provider could not start this handoff.",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
