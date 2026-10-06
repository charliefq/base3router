import {
  EnvironmentId,
  MessageId,
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
const encodeRouteBinding = Schema.encodeSync(Schema.fromJsonString(DispatcherTaskRouteBinding));
const encodePayload = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      branch: Schema.optional(Schema.String),
      worktreePath: Schema.optional(Schema.Null),
      modelSelection: Schema.optional(
        Schema.Struct({
          instanceId: Schema.String,
          model: Schema.String,
        }),
      ),
      text: Schema.optional(Schema.String),
      userMessageId: Schema.optional(Schema.String),
      files: Schema.optional(
        Schema.Array(
          Schema.Struct({
            path: Schema.String,
            kind: Schema.String,
            additions: Schema.Number,
            deletions: Schema.Number,
          }),
        ),
      ),
    }),
  ),
);
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
  const assistantText = `## Completed work

Implemented [handoff](/workspace/project/src/handoff.ts). A private file at /private/secret was not used.

## Remaining steps

Add the destination validation tests.

## Test results

The focused handoff test passed.`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${threadId}, 'project-1', 'Task', 'codex', 'full-access', 'default', ${now}, ${now},
      ${encodePayload({
        branch: "feature/handoff",
        worktreePath: null,
        modelSelection: { instanceId: sourceInstanceId, model: "gpt-5.4" },
      })}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (
      ${sourceMessageId}, ${threadId}, ${sourceTurnId}, 'user', 0, ${now}, ${now},
      ${encodePayload({ text: "Build the feature" })}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (
      'assistant-1', ${threadId}, ${sourceTurnId}, 'assistant', 0, ${now}, ${now},
      ${encodePayload({ text: assistantText })}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
    ) VALUES (
      ${sourceTurnId}, ${threadId}, 1, 'codex', 'completed', ${now}, ${now},
      ${encodePayload({ userMessageId: sourceMessageId })}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_checkpoints (
      checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope,
      status, captured_at, payload_json
    ) VALUES (
      'checkpoint-1', ${threadId}, 'scope-1', ${sourceTurnId}, 'node-1', 1, 'ready', ${now},
      ${encodePayload({
        files: [
          { path: "src/handoff.ts", kind: "modified", additions: 2, deletions: 0 },
          { path: "/private/secret", kind: "modified", additions: 1, deletions: 0 },
        ],
      })}
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
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${encodePayload({ text: "Phase A is done." })} WHERE message_id = 'assistant-1'`;
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
        UPDATE orchestration_v2_projection_messages
        SET payload_json = ${encodePayload({
          text: `## Completed work

Used Bearer secret-bearer-value and sk-secretvalue1234 while reviewing https://example.test/private.

The runner reported API_TOKEN=secret-environment-value before cleanup.

## Remaining steps

Inspect /home/example/private and [the workspace file](/workspace/project/src/handoff.ts).

## Test results

Unknown`,
        })}
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
