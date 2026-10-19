import {
  EnvironmentId,
  WorkflowOperationError,
  WorkflowRun,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeOS from "node:os";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";
import { projectWorkflowEvent, type WorkflowRecordedEvent } from "./Projection.ts";
import {
  previewWorkflowStage,
  dispatchWorkflowStage,
  performWorkflowAction,
  workflowCatalogForProject,
  type WorkflowRecordCommand,
} from "./Workflow.ts";

const isWorkflowOperationError = Schema.is(WorkflowOperationError);
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
  yield* sql`DELETE FROM projection_workflow_decisions`;
  yield* sql`DELETE FROM projection_workflow_artifacts`;
  yield* sql`DELETE FROM projection_workflow_stage_attempts`;
  yield* sql`DELETE FROM projection_workflow_runs`;
  yield* sql`DELETE FROM projection_workflow_cursors`;
  yield* sql`DELETE FROM base3_workflow_commands`;
  yield* sql`DELETE FROM base3_workflow_dispatches`;
  yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Project', '/tmp/workflow-rpc', '[]', ${at}, ${at})`;
});

const seedBuildGate = Effect.fn("workflow.rpc.seedBuildGate")(function* (
  dispatchId?: string,
  proposedOnly = false,
) {
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
      threadId: ThreadId.make(dispatchId ? `workflow-${dispatchId}` : "thread-1"),
      messageId: MessageId.make(dispatchId ? `workflow-message-${dispatchId}` : "message-1"),
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
  if (proposedOnly) return;
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
  it.effect(
    "rejects a prior attempt's matching dispatch after a revision advances the attempt",
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* insertProject();
        yield* seedBuildGate("old-dispatch");
        yield* performWorkflowAction(
          {
            type: "decision.record",
            projectId,
            commandId: "revise-gate",
            decisionId: "revision",
            runId: "run-1",
            stageId: "build_gate",
            attempt: 1,
            artifactId: null,
            value: "request_revision",
            revisionFeedback: {
              text: "Revise the saved discovery output",
              source: {
                runId: "run-1",
                stageId: "discovery",
                attempt: 1,
                artifactId: "artifact-1",
              },
            },
          },
          noopDispatch,
        );
        let launchCount = 0;
        const result = yield* Effect.exit(
          dispatchWorkflowStage(
            {
              environmentId,
              projectId,
              runId: "run-1",
              stageId: "discovery",
              attempt: 1,
              dispatchId: "old-dispatch",
              target: route.target,
              additionalInstruction: "",
            },
            {
              environmentId,
              providers: [provider(true)],
              environmentDefaultModelSelection: null,
              launch: () =>
                Effect.sync(() => {
                  launchCount++;
                  return { sequence: 1 };
                }),
            },
          ),
        );
        assert.equal(launchCount, 0);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          if (!isWorkflowOperationError(error)) throw error;
          assert.equal(error.message, "Stage preview is stale.");
        }
      }),
  );
  it.effect("rolls back stage projection when its command ledger write fails", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* insertProject();
      yield* seedBuildGate();
      yield* performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: "approve-atomic",
          decisionId: "decision-atomic",
          runId: "run-1",
          stageId: "build_gate",
          attempt: 1,
          artifactId: null,
          value: "approve",
        },
        noopDispatch,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TRIGGER reject_stage_receipt BEFORE INSERT ON base3_workflow_commands
        WHEN NEW.command_id = 'workflow-dispatch-atomic'
        BEGIN SELECT RAISE(ABORT, 'injected-ledger-failure'); END`;
      const preview = yield* previewWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          preferredRoute: route.target,
          taskContract: {
            goal: "Atomic architecture start",
            redirect: "One stage",
            acceptance: "Human reviews actual output",
            brake: {
              maxProviderStarts: 1,
              maxTokens: 4000,
              deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
              stopConditions: "Stop before successor",
            },
          },
        },
        { environmentId, providers: [provider(true)], environmentDefaultModelSelection: null },
      );
      if (!preview.review) return yield* Effect.die("Missing atomic review");
      let launches = 0;
      const result = yield* Effect.exit(
        dispatchWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            stageId: "architecture",
            attempt: 1,
            dispatchId: "atomic",
            target: route.target,
            additionalInstruction: "",
            review: preview.review,
          },
          {
            environmentId,
            providers: [provider(true)],
            environmentDefaultModelSelection: null,
            launch: () =>
              Effect.sync(() => {
                launches++;
                return { sequence: 1 };
              }),
          },
        ),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(launches, 1);
      assert.equal(
        (yield* sql`SELECT * FROM base3_workflow_dispatches WHERE dispatch_id='atomic'`).length,
        1,
      );
      const catalog = yield* workflowCatalogForProject(projectId);
      assert.equal(
        catalog.runs[0]?.attempts.find((attempt) => attempt.stageId === "architecture")
          ?.destinationThreadId,
        null,
      );
      yield* sql`DROP TRIGGER reject_stage_receipt`;
    }),
  );
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
      // Receipts written before configuration support have no original input field.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE base3_workflow_commands SET mutation_json=json_remove(mutation_json,'$.input') WHERE command_id=${input.commandId}`;
      const legacyReplay = yield* performWorkflowAction(input, noopDispatch);
      assert.equal(legacyReplay.runs[0]?.currentStageId, "architecture");
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
      const draftInput = {
        environmentId,
        projectId,
        runId: "run-1",
        stageId: "architecture",
        attempt: 1,
        dispatchId: "dispatch-arch-1",
        target: route.target,
        additionalInstruction: "",
      };
      const review = (yield* previewWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          preferredRoute: route.target,
          taskContract: {
            goal: "Architecture",
            redirect: "Current stage only",
            acceptance: "Human review",
            brake: {
              maxProviderStarts: 1,
              maxTokens: 4000,
              deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
              stopConditions: "Stop after output",
            },
          },
        },
        { environmentId, providers: [provider(true)], environmentDefaultModelSelection: null },
      )).review;
      const dispatchInput = { ...draftInput, ...(review ? { review } : {}) };
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
      const review = (yield* previewWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          preferredRoute: route.target,
          additionalInstruction: "Stay on the bound route.",
          taskContract: {
            goal: "Architecture",
            redirect: "Current stage only",
            acceptance: "Human review",
            brake: {
              maxProviderStarts: 1,
              maxTokens: 4000,
              deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
              stopConditions: "Stop after output",
            },
          },
        },
        { environmentId, providers: [provider(true)], environmentDefaultModelSelection: null },
      )).review;
      const dispatched = yield* dispatchWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          stageId: "architecture",
          attempt: 1,
          dispatchId: "dispatch-arch-2",
          ...(review ? { review } : {}),
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
  const filename = `${NodeOS.tmpdir()}/workflow-rpc-human-decision.sqlite`;
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
  const read = workflowCatalogForProject(projectId).pipe(Effect.provide(layer));
  return Effect.gen(function* () {
    const first = yield* write;
    assert.equal(first.runs[0]?.currentStageId, "architecture");
    const second = yield* read;
    assert.equal(second.runs[0]?.currentStageId, "architecture");
    assert.equal(second.runs[0]?.decisions.at(-1)?.value, "approve");
  });
});

it.effect(
  "revisits the human gate with a fresh occurrence after explicit revision, preserving decisions across reload and replay",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate();
      const sql = yield* SqlClient.SqlClient;
      let launches = 0;
      const decision = (
        stageId: string,
        attempt: number,
        value: "approve" | "request_revision",
        artifactId: string | null,
      ) => ({
        type: "decision.record" as const,
        projectId,
        commandId: `cmdrun-1${stageId}${attempt}${value}`,
        decisionId: `drun-1${stageId}${attempt}`,
        runId: "run-1",
        stageId,
        attempt,
        artifactId,
        value,
        ...(value === "request_revision"
          ? {
              revisionFeedback: {
                text: "Revise discovery before the gate",
                source: {
                  runId: "run-1",
                  stageId: "discovery",
                  attempt: 1,
                  artifactId: "artifact-1",
                },
              },
            }
          : {}),
      });
      const revise = decision("build_gate", 1, "request_revision", null);
      const revised = yield* performWorkflowAction(revise, noopDispatch);
      assert.equal(revised.runs[0]?.attempts.at(-1)?.attempt, 2);
      assert.equal(revised.runs[0]?.attempts.at(-1)?.status, "pending");
      assert.equal(launches, 0);
      const reviewed = yield* previewWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          preferredRoute: route.target,
          taskContract: {
            goal: "Revised Discovery",
            redirect: "One occurrence",
            acceptance: "Human gate reviews again",
            brake: {
              maxProviderStarts: 1,
              maxTokens: 4000,
              deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
              stopConditions: "Stop before gate",
            },
          },
        },
        { environmentId, providers: [provider(true)], environmentDefaultModelSelection: null },
      );
      if (!reviewed.review) return yield* Effect.die("missing revision review");
      assert.equal(launches, 0);
      yield* dispatchWorkflowStage(
        {
          environmentId,
          projectId,
          runId: "run-1",
          stageId: "discovery",
          attempt: 2,
          dispatchId: "revision-start-2",
          target: route.target,
          additionalInstruction: "",
          review: reviewed.review,
        },
        {
          environmentId,
          providers: [provider(true)],
          environmentDefaultModelSelection: null,
          launch: () =>
            Effect.sync(() => {
              launches++;
              return { sequence: 1 };
            }),
        },
      );
      const cursor = yield* sql<{
        sequence: number;
      }>`SELECT last_sequence AS sequence FROM projection_workflow_cursors WHERE project_id=${projectId}`;
      yield* projectWorkflowEvent(
        event(cursor[0]!.sequence + 1, {
          type: "artifact.propose",
          artifact: {
            ...discoveryArtifact(),
            id: "artifact-2",
            attempt: 2,
            sourceOutcome: "completed",
            sourceTurnId: TurnId.make("revision-turn-2"),
          },
        }),
      );
      const gated = yield* performWorkflowAction(
        decision("discovery", 2, "approve", "artifact-2"),
        noopDispatch,
      );
      assert.equal(gated.runs[0]?.currentStageId, "build_gate");
      assert.equal(gated.runs[0]?.attempts.at(-1)?.attempt, 2);
      assert.equal(gated.runs[0]?.attempts.at(-1)?.status, "pending");
      assert.equal(launches, 1);
      const reloaded = yield* workflowCatalogForProject(projectId);
      assert.deepEqual(reloaded.runs, gated.runs);
      const oldReplay = yield* performWorkflowAction(revise, noopDispatch);
      assert.deepEqual(oldReplay.runs, gated.runs);
      const approve = decision("build_gate", 2, "approve", null);
      const approved = yield* performWorkflowAction(approve, noopDispatch);
      assert.equal(approved.runs[0]?.currentStageId, "architecture");
      assert.equal(approved.runs[0]?.attempts.at(-1)?.status, "pending");
      assert.equal(approved.runs[0]?.attempts.at(-1)?.destinationThreadId, null);
      assert.deepEqual(
        approved.runs[0]?.artifacts.map((a) => [a.id, a.status]),
        [
          ["artifact-1", "accepted"],
          ["artifact-2", "accepted"],
        ],
      );
      assert.equal(approved.runs[0]?.decisions.filter((d) => d.stageId === "build_gate").length, 2);
      assert.deepEqual((yield* performWorkflowAction(approve, noopDispatch)).runs, approved.runs);
      assert.deepEqual((yield* workflowCatalogForProject(projectId)).runs, approved.runs);
      assert.equal(launches, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

memoryLayer("saved workflow revision feedback", (it) => {
  it.effect.each(["discovery", "build_gate"] as const)(
    "persists %s feedback and includes the exact source in its direct revision packet",
    (stageId) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* insertProject();
        yield* seedBuildGate(undefined, stageId === "discovery");
        let starts = 0;
        const feedback = {
          text: "Keep the market evidence; add the missing parser constraint.",
          source: { runId: "run-1", stageId: "discovery", attempt: 1, artifactId: "artifact-1" },
        };
        const input = {
          type: "decision.record" as const,
          projectId,
          commandId: "saved-feedback",
          decisionId: "saved-feedback-decision",
          runId: "run-1",
          stageId,
          attempt: 1,
          artifactId: stageId === "discovery" ? "artifact-1" : null,
          value: "request_revision" as const,
          revisionFeedback: feedback,
        };
        const saved = yield* performWorkflowAction(input, noopDispatch);
        expect(saved.runs[0]!.decisions.at(-1)).toMatchObject({ revisionFeedback: feedback });
        expect(saved.runs[0]!.attempts.at(-1)).toMatchObject({
          stageId: "discovery",
          attempt: 2,
          status: "pending",
          revisionDecisionId: input.decisionId,
        });
        yield* performWorkflowAction(input, noopDispatch);
        expect(
          (yield* workflowCatalogForProject(projectId)).runs[0]!.attempts.filter(
            (a) => a.stageId === "discovery",
          ),
        ).toHaveLength(2);
        const taskContract = {
          goal: "Revision fixture",
          redirect: "Current stage",
          acceptance: "Owner inspects revised output",
          brake: {
            maxProviderStarts: 1,
            maxTokens: 1000,
            deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
            stopConditions: "No successor",
          },
        };
        const deps = {
          environmentId,
          providers: [provider(true)],
          environmentDefaultModelSelection: null,
        };
        const preview = yield* previewWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            preferredRoute: route.target,
            taskContract,
            additionalInstruction: "Separate operator instruction",
          },
          deps,
        );
        expect(preview.packetText).toContain(feedback.text);
        expect(preview.packetText).toContain("artifact-1");
        expect(starts).toBe(0);
        let packet = "";
        yield* dispatchWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            stageId: "discovery",
            attempt: 2,
            dispatchId: "feedback-explicit-start",
            target: route.target,
            additionalInstruction: "Separate operator instruction",
            review: preview.review!,
          },
          {
            ...deps,
            launch: (input) =>
              Effect.sync(() => {
                starts++;
                packet = input.prompt;
                return { sequence: 1 };
              }),
          },
        );
        expect(starts).toBe(1);
        expect(packet).toContain(feedback.text);
        expect(packet).toContain("Separate operator instruction");
      }),
  );
});

const feedbackSource = {
  runId: "run-1",
  stageId: "discovery",
  attempt: 1,
  artifactId: "artifact-1",
};
const feedbackAction = () => ({
  type: "decision.record" as const,
  projectId,
  commandId: "revision-feedback-command",
  decisionId: "revision-feedback-decision",
  runId: "run-1",
  stageId: "discovery",
  attempt: 1,
  artifactId: "artifact-1",
  value: "request_revision" as const,
  revisionFeedback: {
    text: "Preserve the observations and revise the missing constraint.",
    source: feedbackSource,
  },
});
const encodeRevisionRun = Schema.encodeEffect(Schema.fromJsonString(WorkflowRun));
memoryLayer("workflow revision feedback safety", (it) => {
  it.effect.each([
    "missing",
    "blank",
    "oversized",
    "wrong-source-run",
    "wrong-source-stage",
    "wrong-source-attempt",
    "wrong-artifact",
    "wrong-run",
    "wrong-stage",
    "wrong-attempt",
    "wrong-project",
  ] as const)("rejects %s feedback without mutating the workflow", (change) =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate(undefined, true);
      const before = yield* workflowCatalogForProject(projectId);
      let input: Parameters<typeof performWorkflowAction>[0] = feedbackAction();
      if (input.type !== "decision.record") throw new Error("Fixture command");
      if (change === "missing") {
        const { revisionFeedback: _feedback, ...rest } = input;
        input = rest;
      }
      if (change === "blank")
        input = {
          ...input,
          revisionFeedback: { ...feedbackAction().revisionFeedback, text: " \n\t " },
        };
      if (change === "oversized")
        input = {
          ...input,
          revisionFeedback: { ...feedbackAction().revisionFeedback, text: "x".repeat(2001) },
        };
      if (change.startsWith("wrong-source") || change === "wrong-artifact")
        input = {
          ...input,
          revisionFeedback: {
            ...feedbackAction().revisionFeedback,
            source: {
              ...feedbackSource,
              ...(change === "wrong-source-run"
                ? { runId: "other-run" }
                : change === "wrong-source-stage"
                  ? { stageId: "architecture" }
                  : change === "wrong-source-attempt"
                    ? { attempt: 2 }
                    : { artifactId: "other-artifact" }),
            },
          },
        };
      if (change === "wrong-run") input = { ...input, runId: "wrong-run" };
      if (change === "wrong-stage") input = { ...input, stageId: "architecture" };
      if (change === "wrong-attempt") input = { ...input, attempt: 2 };
      if (change === "wrong-project")
        input = { ...input, projectId: ProjectId.make("other-project") };
      expect((yield* Effect.exit(performWorkflowAction(input, noopDispatch)))._tag).toBe("Failure");
      expect(yield* workflowCatalogForProject(projectId)).toEqual(before);
    }),
  );
  it.effect(
    "seals identical decision aliases and rejects changed feedback or provenance under reused identities",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* insertProject();
        yield* seedBuildGate(undefined, true);
        const input = feedbackAction();
        yield* performWorkflowAction(input, noopDispatch);
        yield* performWorkflowAction({ ...input, commandId: "revision-alias" }, noopDispatch);
        for (const changed of [
          {
            ...input,
            revisionFeedback: { ...input.revisionFeedback, text: "Changed requested changes" },
          },
          {
            ...input,
            commandId: "revision-alias",
            revisionFeedback: { ...input.revisionFeedback, text: "Changed alias payload" },
          },
          {
            ...input,
            commandId: "new-command-old-decision",
            revisionFeedback: { ...input.revisionFeedback, text: "Changed decision payload" },
          },
          {
            ...input,
            revisionFeedback: {
              ...input.revisionFeedback,
              source: { ...feedbackSource, artifactId: "other-artifact" },
            },
          },
        ])
          expect((yield* Effect.exit(performWorkflowAction(changed, noopDispatch)))._tag).toBe(
            "Failure",
          );
        expect((yield* workflowCatalogForProject(projectId)).runs[0]!.attempts).toHaveLength(2);
      }),
  );
  it.effect("review digest binds full feedback source beyond the bounded excerpt", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate(undefined, true);
      const sql = yield* SqlClient.SqlClient;
      const original = (yield* workflowCatalogForProject(projectId)).runs[0]!;
      const expanded = {
        ...original,
        artifacts: original.artifacts.map((a) => ({
          ...a,
          sections: a.sections.map((s, i) => ({
            ...s,
            content: i === 0 ? "a".repeat(2000) : "Exact tail evidence",
            missing: false,
          })),
        })),
      };
      yield* sql`UPDATE projection_workflow_runs SET run_json=${yield* encodeRevisionRun(expanded)} WHERE run_id='run-1'`;
      yield* performWorkflowAction(feedbackAction(), noopDispatch);
      const taskContract = {
        goal: "Revision",
        redirect: "Current stage",
        acceptance: "Owner",
        brake: {
          maxProviderStarts: 1,
          maxTokens: 1000,
          deadlineAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 })),
          stopConditions: "Scope",
        },
      };
      const deps = {
        environmentId,
        providers: [provider(true)],
        environmentDefaultModelSelection: null,
      };
      const preview = yield* previewWorkflowStage(
        { environmentId, projectId, runId: "run-1", preferredRoute: route.target, taskContract },
        deps,
      );
      expect(preview.packetText).toContain("excerpt truncated");
      const saved = (yield* workflowCatalogForProject(projectId)).runs[0]!;
      const altered = {
        ...saved,
        artifacts: saved.artifacts.map((a) => ({
          ...a,
          sections: a.sections.map((s, i) =>
            i === a.sections.length - 1 ? { ...s, content: "CHANGED TAIL" } : s,
          ),
        })),
      };
      yield* sql`UPDATE projection_workflow_runs SET run_json=${yield* encodeRevisionRun(altered)} WHERE run_id='run-1'`;
      const next = yield* previewWorkflowStage(
        { environmentId, projectId, runId: "run-1", preferredRoute: route.target, taskContract },
        deps,
      );
      expect(next.packetText).toBe(preview.packetText);
      let starts = 0;
      const result = yield* Effect.exit(
        dispatchWorkflowStage(
          {
            environmentId,
            projectId,
            runId: "run-1",
            stageId: "discovery",
            attempt: 2,
            dispatchId: "stale-source-review",
            target: route.target,
            additionalInstruction: "",
            review: preview.review!,
          },
          {
            ...deps,
            launch: () =>
              Effect.sync(() => {
                starts++;
                return { sequence: 1 };
              }),
          },
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(starts).toBe(0);
    }),
  );
});

memoryLayer("workflow feedback legacy and bounds", (it) => {
  it.effect(
    "replays missing historical feedback honestly and never invents requested changes",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* insertProject();
        yield* seedBuildGate(undefined, true);
        const legacy: WorkflowMutation = {
          type: "decision.record",
          decision: {
            id: "legacy-revision",
            runId: "run-1",
            stageId: "discovery",
            attempt: 1,
            artifactId: "artifact-1",
            value: "request_revision",
            createdAt: at,
          },
        };
        yield* projectWorkflowEvent(event(4, legacy));
        yield* projectWorkflowEvent(event(4, legacy));
        const before = (yield* workflowCatalogForProject(projectId)).runs[0]!;
        expect(before.attempts).toHaveLength(2);
        expect(before.decisions[0]!.revisionFeedback).toBeUndefined();
        const deps = {
          environmentId,
          providers: [provider(true)],
          environmentDefaultModelSelection: null,
        };
        const preview = yield* previewWorkflowStage(
          { environmentId, projectId, runId: "run-1", preferredRoute: route.target },
          deps,
        );
        expect(preview.packetText).toContain("Historical revision feedback unavailable");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_workflow_runs SET run_json=json_remove(run_json,'$.attempts[1].revisionDecisionId') WHERE run_id='run-1'`;
        const oldProjection = yield* previewWorkflowStage(
          { environmentId, projectId, runId: "run-1", preferredRoute: route.target },
          deps,
        );
        expect(oldProjection.packetText).toContain("Historical revision feedback unavailable");
      }),
  );
  it.effect("rolls back feedback and the pending revision when ledger persistence fails", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate(undefined, true);
      const before = yield* workflowCatalogForProject(projectId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TRIGGER fail_feedback_ledger BEFORE INSERT ON base3_workflow_commands BEGIN SELECT RAISE(ABORT,'fixture-feedback-ledger-failure'); END`;
      expect((yield* Effect.exit(performWorkflowAction(feedbackAction(), noopDispatch)))._tag).toBe(
        "Failure",
      );
      expect(yield* workflowCatalogForProject(projectId)).toEqual(before);
      yield* sql`DROP TRIGGER fail_feedback_ledger`;
    }),
  );
  it.effect("rejects exhausted revision limits and a gate which was already decided", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate(undefined, true);
      const sql = yield* SqlClient.SqlClient;
      const original = (yield* workflowCatalogForProject(projectId)).runs[0]!;
      const limit = template.stages[0]!.maxAttempts;
      const exhausted = {
        ...original,
        attempts: original.attempts.map((a) => ({ ...a, attempt: limit })),
        artifacts: original.artifacts.map((a) => ({ ...a, attempt: limit })),
      };
      yield* sql`UPDATE projection_workflow_runs SET run_json=${yield* encodeRevisionRun(exhausted)} WHERE run_id='run-1'`;
      const input = feedbackAction();
      expect(
        (yield* Effect.exit(
          performWorkflowAction(
            {
              ...input,
              attempt: limit,
              revisionFeedback: {
                ...input.revisionFeedback,
                source: { ...feedbackSource, attempt: limit },
              },
            },
            noopDispatch,
          ),
        ))._tag,
      ).toBe("Failure");
      yield* insertProject();
      yield* seedBuildGate();
      yield* performWorkflowAction(
        {
          type: "decision.record",
          projectId,
          commandId: "decide-gate",
          decisionId: "decided-gate",
          runId: "run-1",
          stageId: "build_gate",
          attempt: 1,
          artifactId: null,
          value: "approve",
        },
        noopDispatch,
      );
      expect(
        (yield* Effect.exit(
          performWorkflowAction(
            { ...input, stageId: "build_gate", artifactId: null },
            noopDispatch,
          ),
        ))._tag,
      ).toBe("Failure");
    }),
  );
  it.effect(
    "a Build Gate revision excludes a globally later unrelated artifact and unrelated feedback",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* insertProject();
        yield* seedBuildGate();
        const sql = yield* SqlClient.SqlClient;
        const original = (yield* workflowCatalogForProject(projectId)).runs[0]!;
        const extra = {
          ...original.artifacts[0]!,
          id: "unrelated-artifact",
          stageId: "architecture",
          status: "accepted" as const,
          sections: [{ label: "Other", content: "UNRELATED ARTIFACT TEXT", missing: false }],
        };
        const altered = {
          ...original,
          artifacts: [...original.artifacts, extra],
          decisions: [
            ...original.decisions,
            {
              id: "unrelated-feedback",
              runId: "run-1",
              stageId: "architecture",
              attempt: 1,
              artifactId: "unrelated-artifact",
              value: "request_revision" as const,
              createdAt: at,
              revisionFeedback: {
                text: "UNRELATED FEEDBACK TEXT",
                source: {
                  runId: "run-1",
                  stageId: "architecture",
                  attempt: 1,
                  artifactId: "unrelated-artifact",
                },
              },
            },
          ],
        };
        yield* sql`UPDATE projection_workflow_runs SET run_json=${yield* encodeRevisionRun(altered)} WHERE run_id='run-1'`;
        yield* performWorkflowAction(
          { ...feedbackAction(), stageId: "build_gate", artifactId: null },
          noopDispatch,
        );
        const preview = yield* previewWorkflowStage(
          { environmentId, projectId, runId: "run-1", preferredRoute: route.target },
          { environmentId, providers: [provider(true)], environmentDefaultModelSelection: null },
        );
        expect(preview.packetText).toContain(feedbackAction().revisionFeedback.text);
        expect(preview.packetText).toContain("artifact-1");
        expect(preview.packetText).not.toContain("UNRELATED");
      }),
  );
});

memoryLayer("workflow feedback global identity", (it) => {
  it.effect("rejects a decision ID already sealed to another workflow run", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* insertProject();
      yield* seedBuildGate(undefined, true);
      yield* performWorkflowAction(
        {
          type: "run.start",
          projectId,
          commandId: "other-run-create",
          runId: "other-run",
          templateId: template.id,
          templateVersion: template.version,
          originatingThreadId: null,
          originatingMessageId: null,
        },
        noopDispatch,
      );
      yield* projectWorkflowEvent(
        event(5, {
          type: "stage.dispatch",
          runId: "other-run",
          stageId: "discovery",
          attempt: 1,
          threadId: ThreadId.make("other-thread"),
          messageId: MessageId.make("other-message"),
          routeBinding: route,
          at,
        }),
      );
      yield* projectWorkflowEvent(
        event(6, {
          type: "artifact.propose",
          artifact: { ...discoveryArtifact(), id: "other-source", runId: "other-run" },
        }),
      );
      yield* projectWorkflowEvent(
        event(7, {
          type: "decision.record",
          decision: {
            id: "foreign-decision",
            runId: "other-run",
            stageId: "discovery",
            attempt: 1,
            artifactId: "other-source",
            value: "approve",
            createdAt: at,
          },
        }),
      );
      const before = yield* workflowCatalogForProject(projectId);
      expect(
        (yield* Effect.exit(
          performWorkflowAction(
            { ...feedbackAction(), decisionId: "foreign-decision" },
            noopDispatch,
          ),
        ))._tag,
      ).toBe("Failure");
      expect(yield* workflowCatalogForProject(projectId)).toEqual(before);
    }),
  );
});
