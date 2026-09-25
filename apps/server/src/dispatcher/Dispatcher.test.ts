// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type DispatcherRoutePreviewRequest,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";

import {
  bindDispatcherTurnStartCommand,
  evaluateActionGate,
  persistDispatcherTaskRoute,
  previewDispatcherRoute,
  readDispatcherTaskRoute,
  readDispatcherProjectedState,
  resolveDispatcherProject,
  resolveDispatcherRoute,
  summarizeDispatcherMessage,
  taskRouteBindingFromDecision,
  type DispatcherProjectedState,
  type DispatcherResolutionInput,
} from "./Dispatcher.ts";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadA = ThreadId.make("thread-a");

const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const provider = (input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly models: ReadonlyArray<string>;
  readonly defaultModel?: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly availability?: ServerProvider["availability"];
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver ?? input.instanceId),
  enabled: input.enabled ?? true,
  installed: input.installed ?? true,
  version: null,
  status: input.status ?? "ready",
  auth: { status: input.authStatus ?? "authenticated" },
  checkedAt: "2026-09-24T00:00:00.000Z",
  ...(input.availability === undefined ? {} : { availability: input.availability }),
  models: input.models.map((model) => ({
    slug: model,
    name: model,
    isCustom: false,
    capabilities: null,
    ...(model === input.defaultModel ? { isDefault: true } : {}),
  })),
  slashCommands: [],
  skills: [],
});

const projected: DispatcherProjectedState = {
  projects: [
    {
      id: projectA,
      workspaceRoot: "/workspace/a",
      defaultModelSelection: selection("project_provider", "project-model"),
      deletedAt: null,
    },
    {
      id: projectB,
      workspaceRoot: "/workspace/b",
      defaultModelSelection: null,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadA,
      projectId: projectA,
      modelSelection: selection("thread_provider", "thread-model"),
      deletedAt: null,
    },
  ],
};

const request = (
  overrides: Partial<DispatcherRoutePreviewRequest> = {},
): DispatcherRoutePreviewRequest => ({
  environmentId,
  projectId: projectA,
  actionKind: "workspace-write",
  ...overrides,
});

const resolutionInput = (
  overrides: Partial<DispatcherResolutionInput> = {},
): DispatcherResolutionInput => ({
  environmentId,
  request: request({ threadId: threadA }),
  projected,
  message: null,
  providers: [
    provider({ instanceId: "thread_provider", models: ["thread-model"] }),
    provider({ instanceId: "project_provider", models: ["project-model"] }),
  ],
  environmentDefaultModelSelection: null,
  ...overrides,
});

it.effect("reads only dispatcher-approved project and thread projection columns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
      VALUES
      ('dispatcher-project', 'Dispatcher', '/private/dispatcher', '{"instanceId":"codex_work","model":"gpt-5.4"}', '[]', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', NULL),
      ('dispatcher-deleted', 'Deleted', '/private/deleted', NULL, '[]', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', '2026-09-24T00:01:00Z')`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, deleted_at)
      VALUES ('dispatcher-thread', 'dispatcher-project', 'Thread', '{"instanceId":"codex_work","model":"gpt-5.4"}', 'full-access', 'default', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', '2026-09-24T00:02:00Z')`;

    const state = yield* readDispatcherProjectedState({
      threadId: ThreadId.make("dispatcher-thread"),
    });

    expect(state).toEqual({
      projects: [
        {
          id: "dispatcher-deleted",
          workspaceRoot: "/private/deleted",
          defaultModelSelection: null,
          deletedAt: "2026-09-24T00:01:00Z",
        },
        {
          id: "dispatcher-project",
          workspaceRoot: "/private/dispatcher",
          defaultModelSelection: { instanceId: "codex_work", model: "gpt-5.4" },
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: "dispatcher-thread",
          projectId: "dispatcher-project",
          modelSelection: { instanceId: "codex_work", model: "gpt-5.4" },
          deletedAt: "2026-09-24T00:02:00Z",
        },
      ],
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("binds the deterministic fallback before any provider work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
      VALUES
      ('project-a', 'Dispatcher', '/workspace/a', '{"instanceId":"project_provider","model":"project-model"}', '[]', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', NULL)`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at, deleted_at)
      VALUES ('thread-a', 'project-a', 'Thread', '{"instanceId":"thread_provider","model":"thread-model"}', 'full-access', 'default', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z', NULL)`;

    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("dispatcher-bind-turn"),
      threadId: threadA,
      message: {
        messageId: MessageId.make("dispatcher-bind-message"),
        role: "user" as const,
        text: "This prose is not routing input.",
        attachments: [],
      },
      modelSelection: selection("unavailable", "unavailable-model"),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: "2026-09-24T00:00:00.000Z",
    };
    const dependencies = {
      enabled: true,
      environmentId: Effect.succeed(environmentId),
      providers: Effect.succeed([
        provider({
          instanceId: "unavailable",
          models: ["unavailable-model"],
          availability: "unavailable",
        }),
        provider({ instanceId: "thread_provider", models: ["thread-model"] }),
        provider({ instanceId: "project_provider", models: ["project-model"] }),
      ]),
      environmentDefaultModelSelection: Effect.succeed(null),
      sql,
    };

    const bound = yield* bindDispatcherTurnStartCommand(command, dependencies);
    expect(bound).toMatchObject({
      routeBinding: {
        target: { instanceId: "thread_provider", model: "thread-model" },
        fallbackIndex: 1,
        source: "thread",
      },
    });

    const disabled = yield* bindDispatcherTurnStartCommand(command, {
      ...dependencies,
      enabled: false,
      environmentId: Effect.die("disabled dispatcher must not read the environment"),
      providers: Effect.die("disabled dispatcher must not read providers"),
      environmentDefaultModelSelection: Effect.die(
        "disabled dispatcher must not read server settings",
      ),
    });
    expect(disabled).toEqual(command);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

describe("dispatcher project resolution", () => {
  it("resolves by thread before explicit project and normalized workspace root", () => {
    const result = resolveDispatcherProject({
      environmentId,
      request: request({
        threadId: threadA,
        projectId: projectA,
        workspaceRoot: "/workspace/a/",
      }),
      projected,
    });
    expect(result.resolution).toEqual({
      status: "resolved",
      source: "thread",
      projectId: projectA,
      reasonCodes: [],
    });
  });

  it("falls through to project id and then exact normalized workspace root", () => {
    expect(
      resolveDispatcherProject({ environmentId, request: request(), projected }).resolution.source,
    ).toBe("project-id");
    expect(
      resolveDispatcherProject({
        environmentId,
        request: request({ projectId: undefined, workspaceRoot: "/workspace/b/" }),
        projected,
      }).resolution,
    ).toEqual({
      status: "resolved",
      source: "workspace-root",
      projectId: projectB,
      reasonCodes: [],
    });
  });

  it.each([
    {
      name: "cross-environment request",
      environmentId,
      routeRequest: request({ environmentId: otherEnvironmentId }),
      state: projected,
      reason: "ENVIRONMENT_MISMATCH",
    },
    {
      name: "missing thread",
      environmentId,
      routeRequest: request({ threadId: ThreadId.make("missing-thread") }),
      state: projected,
      reason: "THREAD_NOT_FOUND",
    },
    {
      name: "thread/project mismatch",
      environmentId,
      routeRequest: request({ threadId: threadA, projectId: projectB }),
      state: projected,
      reason: "PROJECT_MISMATCH",
    },
    {
      name: "missing project",
      environmentId,
      routeRequest: request({ projectId: ProjectId.make("missing-project") }),
      state: projected,
      reason: "PROJECT_NOT_FOUND",
    },
    {
      name: "deleted project",
      environmentId,
      routeRequest: request(),
      state: {
        ...projected,
        projects: projected.projects.map((project) =>
          project.id === projectA ? { ...project, deletedAt: "2026-09-24T00:00:00.000Z" } : project,
        ),
      },
      reason: "PROJECT_DELETED",
    },
    {
      name: "ambiguous workspace root",
      environmentId,
      routeRequest: request({ projectId: undefined, workspaceRoot: "/workspace/a" }),
      state: {
        ...projected,
        projects: [
          ...projected.projects,
          {
            id: ProjectId.make("project-duplicate"),
            workspaceRoot: "/workspace/a/",
            defaultModelSelection: null,
            deletedAt: null,
          },
        ],
      },
      reason: "PROJECT_AMBIGUOUS",
    },
  ])("rejects $name", ({ environmentId: expectedEnvironment, routeRequest, state, reason }) => {
    const result = resolveDispatcherProject({
      environmentId: expectedEnvironment,
      request: routeRequest,
      projected: state,
    });
    expect(result.resolution.status).toBe("rejected");
    expect(result.resolution.reasonCodes).toEqual([reason]);
  });
});

describe("deterministic route decisions", () => {
  it("orders and de-duplicates candidates by stable precedence", () => {
    const decision = resolveDispatcherRoute(
      resolutionInput({
        request: request({
          threadId: threadA,
          preferredRoute: { instanceId: ProviderInstanceId.make("explicit"), model: "gpt-5.4" },
        }),
        providers: [
          provider({ instanceId: "zeta", models: ["z-model"], defaultModel: "z-model" }),
          provider({ instanceId: "explicit", models: ["gpt-5.4"] }),
          provider({ instanceId: "alpha", models: ["b-model", "a-model"] }),
          provider({ instanceId: "thread_provider", models: ["thread-model"] }),
          provider({ instanceId: "project_provider", models: ["project-model"] }),
          provider({ instanceId: "environment_provider", models: ["environment-model"] }),
        ],
        environmentDefaultModelSelection: selection("environment_provider", "environment-model"),
      }),
    );

    expect(decision.candidates.map(({ source, target }) => ({ source, target }))).toEqual([
      { source: "explicit", target: { instanceId: "explicit", model: "gpt-5.4" } },
      { source: "thread", target: { instanceId: "thread_provider", model: "thread-model" } },
      {
        source: "project-default",
        target: { instanceId: "project_provider", model: "project-model" },
      },
      {
        source: "environment-default",
        target: { instanceId: "environment_provider", model: "environment-model" },
      },
      { source: "provider-default", target: { instanceId: "alpha", model: "a-model" } },
      { source: "provider-default", target: { instanceId: "zeta", model: "z-model" } },
    ]);
    expect(decision.candidates.map((candidate) => candidate.fallbackIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("returns identical decisions for identical projected and provider state", () => {
    const input = resolutionInput();
    expect(resolveDispatcherRoute(input)).toEqual(resolveDispatcherRoute(input));
  });

  it("binds the first eligible deterministic fallback before provider work", () => {
    const decision = resolveDispatcherRoute(
      resolutionInput({
        request: request({
          threadId: threadA,
          preferredRoute: {
            instanceId: ProviderInstanceId.make("unavailable"),
            model: "unavailable-model",
          },
        }),
        providers: [
          provider({
            instanceId: "unavailable",
            models: ["unavailable-model"],
            availability: "unavailable",
          }),
          provider({ instanceId: "thread_provider", models: ["thread-model"] }),
          provider({ instanceId: "project_provider", models: ["project-model"] }),
        ],
      }),
    );

    expect(taskRouteBindingFromDecision(decision)).toMatchObject({
      target: { instanceId: "thread_provider", model: "thread-model" },
      fallbackIndex: 1,
      source: "thread",
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
    });
  });

  it("allows an eligible route and denies explicit structured failures", () => {
    const allowed = resolveDispatcherRoute(resolutionInput());
    expect(allowed.gate).toEqual({ decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] });

    const denied = resolveDispatcherRoute(
      resolutionInput({
        providers: [
          provider({ instanceId: "thread_provider", models: ["thread-model"], enabled: false }),
          provider({ instanceId: "project_provider", models: ["project-model"], enabled: false }),
        ],
      }),
    );
    expect(denied.gate).toEqual({ decision: "DENY", reasonCodes: ["PROVIDER_DISABLED"] });
    expect(
      evaluateActionGate({
        resolution: denied.projectResolution,
        requestedMessageId: MessageId.make("missing-message"),
        message: null,
        candidates: denied.candidates,
      }),
    ).toEqual({ decision: "DENY", reasonCodes: ["MESSAGE_NOT_FOUND"] });
  });

  it("uses persisted message metadata and structured composer records without prompt parsing", () => {
    const message = summarizeDispatcherMessage({
      threadId: threadA,
      message: {
        id: MessageId.make("message-a"),
        role: "user",
        text: "delete everything mentioned in prose",
        attachments: [],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("mention-1"),
              kind: "mention",
              label: "Sensitive file",
              path: "/private/secret.txt",
            },
          ],
        },
        turnId: null,
        streaming: false,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    });
    const decision = resolveDispatcherRoute(
      resolutionInput({
        request: request({ threadId: threadA, messageId: message.id }),
        message,
      }),
    );

    expect(decision.context).toEqual({
      threadId: threadA,
      messageId: message.id,
      hasPersistedMessage: true,
      attachmentCount: 0,
      composerContextKinds: ["mention"],
    });
    expect(decision.gate.decision).toBe("ALLOW");
  });

  it.effect("emits one redacted resolution span without provider or session work", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const sensitivePath = "/private/workspace/customer-secret";
      const state = resolutionInput({
        request: request({
          projectId: undefined,
          threadId: undefined,
          workspaceRoot: sensitivePath,
        }),
        projected: {
          projects: [
            {
              id: projectA,
              workspaceRoot: sensitivePath,
              defaultModelSelection: selection("thread_provider", "thread-model"),
              deletedAt: null,
            },
          ],
          threads: [],
        },
      });

      const decision = yield* previewDispatcherRoute(state).pipe(Effect.withTracer(tracer));
      expect(decision.gate.decision).toBe("ALLOW");
      expect(spans.map((span) => span.name)).toEqual(["dispatcher.route_preview"]);
      const attributes = Object.fromEntries(spans[0]?.attributes ?? []);
      expect(attributes).toMatchObject({
        "dispatcher.policy_version": "dispatcher.phase-1a.v1",
        "dispatcher.resolution_source": "workspace-root",
        "dispatcher.provider_instance": "thread_provider",
        "dispatcher.provider_driver": "thread_provider",
        "dispatcher.model_family": "other",
        "dispatcher.fallback_index": 0,
        "dispatcher.gate_result": "ALLOW",
        "dispatcher.reason_codes": "ACTION_ALLOWED",
      });
      const attributeText = Object.values(attributes).map(String).join("\n");
      expect(attributeText).not.toContain(sensitivePath);
      expect(attributeText).not.toContain("customer-secret");
    }),
  );
});

it.effect("keeps a task route immutable across a database reload", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dispatcher-route-"));
  const dbPath = NodePath.join(directory, "state.sqlite");
  const binding = taskRouteBindingFromDecision(resolveDispatcherRoute(resolutionInput()));
  if (binding === null) throw new Error("Expected an eligible dispatcher binding.");
  const key = { threadId: threadA, messageId: MessageId.make("durable-task") };

  return Effect.gen(function* () {
    const firstLayer = makeSqlitePersistenceLive(dbPath);
    yield* Effect.scoped(
      persistDispatcherTaskRoute({
        ...key,
        binding,
        createdAt: "2026-09-24T00:00:00.000Z",
      }).pipe(Effect.provide(firstLayer)),
    );

    const reloadedLayer = makeSqlitePersistenceLive(dbPath);
    const reloaded = yield* Effect.scoped(
      readDispatcherTaskRoute(key).pipe(Effect.provide(reloadedLayer)),
    );
    expect(Option.getOrNull(reloaded)).toEqual(binding);

    const conflicting = {
      ...binding,
      target: { instanceId: ProviderInstanceId.make("other"), model: "other-model" },
    };
    const conflict = yield* Effect.scoped(
      Effect.exit(
        persistDispatcherTaskRoute({
          ...key,
          binding: conflicting,
          createdAt: "2026-09-24T00:01:00.000Z",
        }).pipe(Effect.provide(reloadedLayer)),
      ),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );
});
