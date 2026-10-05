import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerProvider,
  type WorkflowArtifact,
  type WorkflowMutation,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import { projectWorkflowEvent, type WorkflowRecordedEvent } from "./Projection.ts";
import {
  dispatchWorkflowStage,
  performWorkflowAction,
  workflowCatalogForProject,
  type WorkflowRecordCommand,
} from "./Workflow.ts";

const projectId = ProjectId.make("project-1");
const environmentId = EnvironmentId.make("environment-1");
const at = "2026-09-28T00:00:00.000Z";
const template = BUILTIN_WORKFLOW_TEMPLATES[0]!;
const route = {
  policyVersion: "dispatcher.phase-1a.v1" as const,
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit" as const,
  gate: { decision: "ALLOW" as const, reasonCodes: ["ACTION_ALLOWED" as const] },
};
const provider = (installed: boolean): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed,
  version: null,
  status: installed ? "ready" : "error",
  auth: { status: "authenticated" },
  checkedAt: at,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const noopDispatch = (_command: WorkflowRecordCommand) => Effect.succeed({ sequence: 1 });
const event = (sequence: number, mutation: WorkflowMutation): WorkflowRecordedEvent => ({
  sequence,
  type: "workflow.recorded",
  commandId: `command-${sequence}`,
  payload: { projectId, mutation },
});
const discoveryArtifact = (): WorkflowArtifact => ({
  id: "artifact-1",
  runId: "run-1",
  stageId: "discovery",
  attempt: 1,
  kind: "opportunity_brief",
  sourceTurnId: TurnId.make("turn-1"),
  profileId: "bill",
  profileVersion: 1,
  sections: BUILTIN_AGENT_PROFILES[0]!.requiredOutputSections.map((label) => ({
    label,
    content: "Unknown",
    missing: true,
  })),
  missingSections: [...BUILTIN_AGENT_PROFILES[0]!.requiredOutputSections],
  extractionVersion: 1,
  redacted: false,
  status: "proposed",
  createdAt: at,
  acceptedAt: null,
});

const insertProject = Effect.fn("workflow.rpc.insertProject")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/tmp/workflow-rpc', '[]', ${at}, ${at})`;
});

const seedBuildGate = Effect.fn("workflow.rpc.seedBuildGate")(function* () {
  yield* projectWorkflowEvent(
    event(1, {
      type: "run.start",
      run: initialWorkflowRun({
        runId: "run-1",
        projectId,
        template,
        originThreadId: null,
        originMessageId: null,
        at,
      }),
    }),
  );
  yield* projectWorkflowEvent(
    event(2, {
      type: "stage.dispatch",
      runId: "run-1",
      stageId: "discovery",
      attempt: 1,
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      routeBinding: route,
      at,
    }),
  );
  yield* projectWorkflowEvent(
    event(3, {
      type: "artifact.propose",
      artifact: discoveryArtifact(),
    }),
  );
  yield* projectWorkflowEvent(
    event(4, {
      type: "decision.record",
      decision: {
        id: "decision-1",
        runId: "run-1",
        stageId: "discovery",
        attempt: 1,
        artifactId: "artifact-1",
        value: "approve",
        createdAt: at,
      },
    }),
  );
});

const memoryLayer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

memoryLayer("workflow human decisions", (it) => {
  it.effect("shows a pending human gate and advances only after approve", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      const pending = yield* workflowCatalogForProject(projectId);
      assert.equal(pending.runs[0]?.currentStageId, "build_gate");
      assert.equal(pending.runs[0]?.status, "active");
      const approved = yield* performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: "approve-gate-1",
          decisionId: "decision-2",
          runId: "run-1",
          stageId: "build_gate",
          attempt: 1,
          artifactId: null,
          value: "approve",
        },
        noopDispatch,
      );
      assert.equal(approved.runs[0]?.currentStageId, "architecture");
      assert.equal(approved.runs[0]?.status, "active");
      const refreshed = yield* workflowCatalogForProject(projectId);
      assert.equal(refreshed.runs[0]?.currentStageId, "architecture");
    }),
  );

  it.effect("reject and cancel leave the next stage unstarted", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      const rejected = yield* performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: "reject-gate-1",
          decisionId: "decision-2",
          runId: "run-1",
          stageId: "build_gate",
          attempt: 1,
          artifactId: null,
          value: "reject",
        },
        noopDispatch,
      );
      assert.equal(rejected.runs[0]?.status, "rejected");
      assert.equal(rejected.runs[0]?.currentStageId, null);
      const launch: string[] = [];
      const denied = yield* Effect.exit(
        dispatchWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            stageId: "architecture",
            attempt: 1,
            dispatchId: "dispatch-1",
            target: route.target,
            additionalInstruction: "",
          },
          {
            environmentId,
            providers: [provider(true)],
            environmentDefaultModelSelection: null,
            launch: (payload) =>
              Effect.sync(() => {
                launch.push(payload.threadId);
                return { sequence: 1 };
              }),
          },
        ),
      );
      assert.equal(denied._tag, "Failure");
      assert.equal(launch.length, 0);
    }),
  );

  it.effect("duplicate responses do not dispatch twice", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      const input = {
        type: "decision.record" as const,
        projectId,
        commandId: "approve-gate-1",
        decisionId: "decision-2",
        runId: "run-1",
        stageId: "build_gate",
        attempt: 1,
        artifactId: null,
        value: "approve" as const,
      };
      const first = yield* performWorkflowAction(input, noopDispatch);
      const second = yield* performWorkflowAction(input, noopDispatch);
      assert.equal(first.runs[0]?.currentStageId, "architecture");
      assert.equal(second.runs[0]?.currentStageId, "architecture");
      assert.equal(
        second.runs[0]?.decisions.filter((entry) => entry.id === "decision-2").length,
        1,
      );
      const stale = yield* Effect.exit(
        performWorkflowAction(
          {
            ...input,
            commandId: "approve-gate-2",
            decisionId: "decision-3",
          },
          noopDispatch,
        ),
      );
      assert.equal(stale._tag, "Failure");
      const launches: string[] = [];
      const dispatchInput = {
        environmentId,
        projectId,
        runId: "run-1",
        stageId: "architecture",
        attempt: 1,
        dispatchId: "dispatch-arch-1",
        target: route.target,
        additionalInstruction: "",
      };
      const launched = yield* dispatchWorkflowStage(dispatchInput, {
        environmentId,
        providers: [provider(true)],
        environmentDefaultModelSelection: null,
        launch: (payload) =>
          Effect.sync(() => {
            launches.push(payload.threadId);
            return { sequence: 1 };
          }),
      });
      assert.equal(launched.run.currentStageId, "architecture");
      assert.equal(
        launched.run.attempts.findLast((entry) => entry.stageId === "architecture")?.status,
        "dispatched",
      );
      const replayed = yield* dispatchWorkflowStage(dispatchInput, {
        environmentId,
        providers: [provider(true)],
        environmentDefaultModelSelection: null,
        launch: (payload) =>
          Effect.sync(() => {
            launches.push(payload.threadId);
            return { sequence: 1 };
          }),
      });
      assert.equal(launches.length, 1);
      assert.equal(replayed.threadId, launched.threadId);
    }),
  );

  it.effect("approved stage execution uses the injected governed launch path", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      yield* performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: "approve-gate-1",
          decisionId: "decision-2",
          runId: "run-1",
          stageId: "build_gate",
          attempt: 1,
          artifactId: null,
          value: "approve",
        },
        noopDispatch,
      );
      const closed = yield* Effect.exit(
        dispatchWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            stageId: "architecture",
            attempt: 1,
            dispatchId: "dispatch-cloud-1",
            target: route.target,
            additionalInstruction: "",
            runnerKind: "cursor-cloud",
          },
          {
            environmentId,
            providers: [provider(true)],
            environmentDefaultModelSelection: null,
            launch: () => Effect.succeed({ sequence: 1 }),
          },
        ),
      );
      assert.equal(closed._tag, "Failure");
      const launches: string[] = [];
      const dispatched = yield* dispatchWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          stageId: "architecture",
          attempt: 1,
          dispatchId: "dispatch-arch-2",
          target: route.target,
          additionalInstruction: "Stay on the bound route.",
        },
        {
          environmentId,
          providers: [provider(true)],
          environmentDefaultModelSelection: null,
          launch: (payload) =>
            Effect.sync(() => {
              launches.push(payload.prompt);
              return { sequence: 1 };
            }),
        },
      );
      assert.equal(launches.length, 1);
      expect(launches[0]).toContain("Workflow stage: Architecture");
      assert.equal(dispatched.run.attempts.at(-1)?.routeBinding?.target.model, "gpt-5.4");
    }),
  );

  it.effect("cancel does not start the next stage", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      const cancelled = yield* performWorkflowAction(
        {
          type: "run.cancel",
          projectId,
          commandId: "cancel-1",
          runId: "run-1",
        },
        noopDispatch,
      );
      assert.equal(cancelled.runs[0]?.status, "cancelled");
      assert.equal(cancelled.runs[0]?.currentStageId, null);
    }),
  );
});

it.effect("workflow decisions survive a file-backed server restart", () => {
  const directory = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workflow-rpc-"));
  const filename = NodePath.join(directory, "state.sqlite");
  const layer = NodeSqliteClient.layer({ filename });
  const write = Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* insertProject();
    yield* seedBuildGate();
    return yield* performWorkflowAction(
      {
        type: "decision.record",
        projectId,
        commandId: "approve-gate-1",
        decisionId: "decision-2",
        runId: "run-1",
        stageId: "build_gate",
        attempt: 1,
        artifactId: null,
        value: "approve",
      },
      noopDispatch,
    );
  }).pipe(Effect.provide(layer));
  const read = Effect.gen(function* () {
    return yield* workflowCatalogForProject(projectId);
  }).pipe(Effect.provide(layer));
  return Effect.gen(function* () {
    const first = yield* write;
    assert.equal(first.runs[0]?.currentStageId, "architecture");
    const second = yield* read;
    assert.equal(second.runs[0]?.currentStageId, "architecture");
    assert.equal(second.runs[0]?.decisions.at(-1)?.value, "approve");
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFs.rmSync(directory, { recursive: true, force: true }))),
  );
});
