// @effect-diagnostics nodeBuiltinImport:off
// Explicit disposable production-process verification; never uses the live install.
import * as NodeFS from "node:fs";
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { readLocalProductRuntime } from "./local-product-runtime.ts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  CommandId,
  ProviderInstanceId,
  CollaborationSnapshot,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type TaskFirstLaunch,
  type TaskResultContinuation,
  OrchestrationV2Command,
} from "@t3tools/contracts";
import {
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import * as Commands from "@t3tools/client-runtime/operations";
import { configurationSnapshot, configurationInput } from "@t3tools/shared/agentConfiguration";
import { revisionRequestFacts, continuationResult } from "@t3tools/shared/taskRevisionRequest";
import { makeRpcSessionFactory, request, type RpcSession } from "@t3tools/client-runtime/rpc";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const ProviderRecord = Schema.Struct({
  event: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});
const decodeProviderRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRecord));
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2Command));
const decodeFixtureConfig = Schema.decodeUnknownEffect(
  Schema.Struct({ binaryPath: Schema.String }),
);
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const evidence = NodePath.resolve(
  option("--output") ?? NodePath.join(NodeOS.tmpdir(), "b3r-local-product-evidence"),
);
NodeFS.mkdirSync(evidence, { recursive: true });
const root =
  option("--runtime") ??
  NodeFS.readFileSync(NodePath.join(evidence, "current-runtime-path.txt"), "utf8").trim();
const runtime = readLocalProductRuntime(root);
const origin = `http://127.0.0.1:${runtime.port}`;
const httpJson = (
  path: string,
  input: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(input.method ?? "GET")(origin + path).pipe(
      HttpClientRequest.setHeaders(input.headers ?? {}),
    );
    const response = yield* client.execute(
      input.body === undefined
        ? request
        : request.pipe(
            HttpClientRequest.bodyText(
              input.body,
              input.headers?.["content-type"] ?? "application/json",
            ),
          ),
    );
    NodeAssert.equal(response.status, 200);
    return yield* response.json;
  }).pipe(Effect.provide(FetchHttpClient.layer));
const environmentId = EnvironmentId.make(
  NodeFS.readFileSync(NodePath.join(root, "app/userdata/environment-id"), "utf8").trim(),
);
const accessFile = NodePath.join(root, "access-private.json");
let access: { access_token: string };
const decodeAccess = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
if (NodeFS.existsSync(accessFile))
  access = decodeAccess(decodeJson(NodeFS.readFileSync(accessFile, "utf8")));
else {
  const credential = new URLSearchParams(new URL(runtime.pairingUrl).hash.slice(1)).get("token");
  NodeAssert.ok(credential);
  access = decodeAccess(
    await Effect.runPromise(
      httpJson("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: credential,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          client_label: "Disposable local verification",
        }).toString(),
      }),
    ),
  );
  NodeFS.writeFileSync(accessFile, encodeJson(access), { mode: 0o600 });
}
const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
  await Effect.runPromise(
    httpJson("/api/auth/websocket-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${access.access_token}` },
    }),
  ),
);
const socketUrl = new URL("/ws", origin);
socketUrl.protocol = "ws:";
socketUrl.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
socketUrl.searchParams.set("wsTicket", ticket.ticket);
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const factory = yield* makeRpcSessionFactory().pipe(
        Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
      );
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "LOCAL disposable",
        httpBaseUrl: origin,
        wsBaseUrl: origin.replace("http:", "ws:"),
      });
      const session = yield* factory.connect({
        environmentId,
        label: target.label,
        httpBaseUrl: origin,
        socketUrl: socketUrl.toString(),
        httpAuthorization: { _tag: "Bearer", token: access.access_token },
        target,
      });
      yield* session.ready;
      const active = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(session));
      const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
        Option.none(),
      );
      const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state,
        session: active,
        prepared,
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const initial = yield* session.initialConfig;
      yield* Effect.log(
        encodeJson({
          environmentId,
          providers: initial.providers.map((p) => ({
            id: p.instanceId,
            enabled: p.enabled,
            installed: p.installed,
            status: p.status,
            auth: p.auth.status,
          })),
        }),
      );
      const settings = yield* request(WS_METHODS.serverGetSettings, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      const fixture = settings.providerInstances[ProviderInstanceId.make("codex")];
      NodeAssert.ok(fixture);
      const fixtureConfig = yield* decodeFixtureConfig(fixture.config);
      NodeAssert.equal(fixtureConfig.binaryPath, runtime.providerBinary);
      if (process.argv.includes("--journey") || process.argv.includes("--setup")) {
        if (!fixture.enabled) {
          yield* request(WS_METHODS.serverUpdateSettings, {
            patch: {},
            providerInstanceMutation: {
              operation: "upsert",
              instanceId: ProviderInstanceId.make("codex"),
              instance: { ...fixture, enabled: true },
            },
          }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        }
        const ready = yield* session.subscribeServerConfig({}).pipe(
          Stream.filter((event) =>
            (event.type === "snapshot"
              ? event.config.providers
              : event.type === "providerStatuses"
                ? event.payload.providers
                : []
            ).some((p) => p.instanceId === "codex" && p.status === "ready"),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
        );
        yield* Effect.log(encodeJson({ fixtureReady: true, configReceipts: ready.length }));
      }
      const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      const snapshot = () =>
        httpJson("/api/collaboration", {
          headers: { authorization: `Bearer ${access.access_token}` },
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CollaborationSnapshot)));
      const starts = () =>
        NodeFS.existsSync(NodePath.join(root, "provider-requests.ndjson"))
          ? NodeFS.readFileSync(NodePath.join(root, "provider-requests.ndjson"), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => decodeProviderRecord(line))
              .filter((event) => event.event === "start")
          : [];
      const terminal = (threadId: ThreadId, messageId: MessageId) =>
        session.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }).pipe(
          Stream.filter((item) =>
            item.kind === "snapshot"
              ? item.projection.runs.some(
                  (run) =>
                    run.userMessageId === messageId &&
                    ["completed", "failed", "cancelled", "interrupted"].includes(run.status),
                )
              : item.kind === "event" &&
                item.event.type === "run.updated" &&
                item.event.payload.userMessageId === messageId &&
                ["completed", "failed", "cancelled", "interrupted"].includes(
                  item.event.payload.status,
                ),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
          Effect.forkScoped,
        );
      if (process.argv.includes("--recover")) {
        const beforeStarts = starts().length;
        const proofs = [];
        for (const name of NodeFS.readdirSync(root).filter(
          (name) => name.startsWith("original-") && name.endsWith("-command.json"),
        )) {
          const command = yield* decodeCommand(
            NodeFS.readFileSync(NodePath.join(root, name), "utf8"),
          );
          const proof =
            command.type === "thread.create"
              ? yield* use(Commands.readAgentsCreationStatus({ command }))
              : command.type === "message.dispatch" && command.taskResultContinuation
                ? yield* use(Commands.readTaskResultContinuationStatus({ command }))
                : command.type === "message.dispatch" && command.taskFirstLaunch
                  ? yield* use(Commands.readTaskFirstLaunchStatus({ command }))
                  : null;
          proofs.push({ file: name, commandId: command.commandId, proof });
        }
        NodeAssert.equal(
          starts().length,
          beforeStarts,
          "Read-only recovery must never start a provider",
        );
        NodeFS.writeFileSync(
          NodePath.join(evidence, "production-recovery.json"),
          encodeJson({
            environmentId,
            proofs,
            providerStarts: beforeStarts,
            snapshot: yield* snapshot(),
            recovery: "Original identities read-only; zero resends or replacement commands",
          }),
        );
        yield* Effect.log(
          encodeJson({ recovery: "read-only", providerStarts: beforeStarts, proofs }),
        );
        return;
      }
      if (process.argv.includes("--inspect")) {
        const original = yield* decodeCommand(
          NodeFS.readFileSync(NodePath.join(root, "original-first-command.json"), "utf8"),
        );
        NodeAssert.equal(original.type, "message.dispatch");
        if (original.type !== "message.dispatch") throw Error("Not a dispatch");
        const projection = yield* Commands.readThreadProjection({
          threadId: original.threadId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        const currentSnapshot = yield* snapshot();
        const task = currentSnapshot.tasks.find((task) => task.threadId === original.threadId);
        NodeAssert.ok(task);
        const review = yield* Commands.readTaskReview({
          environmentId,
          projectId: ProjectId.make(task.projectId),
          taskId: task.id,
          threadId: original.threadId,
          revision: 1,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        NodeFS.writeFileSync(
          NodePath.join(evidence, "native-attribution-diagnostic.json"),
          encodeJson({ task, review, projection }),
        );
        yield* Effect.log(
          encodeJson({
            resultReadout: task.resultReadout,
            contractReadout: task.contractReadout,
            reviewStatus: review.status,
          }),
        );
        return;
      }
      if (process.argv.includes("--lifecycle") || process.argv.includes("--inflight")) {
        const mode = process.argv.includes("--inflight") ? "inflight" : "lifecycle";
        NodeFS.writeFileSync(
          NodePath.join(root, `${mode}-begun.json`),
          encodeJson({ at: DateTime.formatIso(yield* DateTime.now) }),
          { flag: "wx", mode: 0o600 },
        );
        const baseline = starts().length;
        const projectId = ProjectId.make("local-product-project");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "fixture-manual",
        };
        const reviewFor = (threadId: ThreadId, revision: number) =>
          Effect.gen(function* () {
            const task = (yield* snapshot()).tasks.find((task) => task.threadId === threadId);
            NodeAssert.ok(task);
            const review = yield* use(
              Commands.readTaskReview({
                environmentId,
                projectId,
                threadId,
                taskId: task.id,
                revision,
              }),
            );
            NodeAssert.equal(review.status, "available");
            if (review.status !== "available") throw Error("Current lifecycle review unavailable");
            return review;
          });
        const prepare = (key: string, hold = true) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`local-${key}-task`);
            const text = hold ? `HOLD_FOR_LOCAL_STOP ${key}` : `Review ${key} without starting`;
            const creation: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
              type: "thread.create",
              commandId: CommandId.make(`local-${key}-create`),
              threadId,
              projectId,
              title: `LOCAL ${key}`,
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
              taskGovernance: "required",
              taskContract: {
                goal: text,
                redirect: "Keep local fixture isolation",
                acceptance: "Review actual lifecycle evidence",
                brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
              },
              taskCreationReview: { environmentId, projectId, modelSelection },
            };
            NodeFS.writeFileSync(
              NodePath.join(root, `original-${key}-creation-command.json`),
              encodeJson(creation),
              { mode: 0o600 },
            );
            yield* use(Commands.createThread(creation));
            const review = yield* reviewFor(threadId, 1);
            const marker: TaskFirstLaunch = {
              commandId: CommandId.make(`local-${key}-start`),
              messageId: MessageId.make(`local-${key}-message`),
              threadId,
              reference: review.reference,
              contract: review.contract,
              text,
              routingMode: "manual",
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
            };
            const original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
              type: "message.dispatch",
              commandId: marker.commandId,
              messageId: marker.messageId,
              threadId,
              text,
              attachments: [],
              modelSelection,
              routingMode: "manual",
              taskFirstLaunch: marker,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            };
            NodeFS.writeFileSync(
              NodePath.join(root, `original-${key}-start-command.json`),
              encodeJson(original),
              {
                mode: 0o600,
              },
            );
            return { threadId, marker, original };
          });
        const startHeld = (prepared: Effect.Success<ReturnType<typeof prepare>>) =>
          Effect.gen(function* () {
            const running = yield* session.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: prepared.threadId,
            }).pipe(
              Stream.filter((item) =>
                item.kind === "snapshot"
                  ? item.projection.providerTurns.some((turn) => turn.status === "running")
                  : item.kind === "event" &&
                    item.event.type === "provider-turn.updated" &&
                    item.event.payload.status === "running",
              ),
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("30 seconds"),
              Effect.forkScoped,
            );
            const marker = prepared.marker;
            yield* use(
              Commands.startThreadTurn({
                commandId: marker.commandId,
                threadId: marker.threadId,
                message: {
                  messageId: marker.messageId,
                  role: "user",
                  text: marker.text,
                  attachments: [],
                },
                modelSelection,
                routingMode: "manual",
                runtimeMode: marker.runtimeMode,
                interactionMode: marker.interactionMode,
                dispatchMode: "start",
                taskFirstLaunch: marker,
              }),
            );
            yield* Fiber.join(running);
            const projection = yield* use(
              Commands.readThreadProjection({ threadId: marker.threadId }),
            );
            const run = projection.runs.find((run) => run.userMessageId === marker.messageId);
            NodeAssert.ok(run);
            NodeAssert.equal(run.status, "running");
            return run;
          });
        if (mode === "inflight") {
          const prepared = yield* prepare("restart-inflight");
          const run = yield* startHeld(prepared);
          NodeAssert.equal(starts().length, baseline + 1);
          NodeFS.writeFileSync(
            NodePath.join(evidence, "production-inflight-before-crash.json"),
            encodeJson({
              environmentId,
              original: prepared.original,
              run,
              providerStarts: starts().length,
              phase: "Actual native held turn; crash/restart must not resend",
            }),
          );
          yield* Effect.log(
            encodeJson({
              inflight: true,
              threadId: prepared.threadId,
              runId: run.id,
              providerStarts: starts().length,
            }),
          );
          return;
        }
        const paused = yield* prepare("pause-edit-resume");
        yield* startHeld(paused);
        const stopped = yield* terminal(paused.threadId, paused.marker.messageId);
        const beforePause = yield* reviewFor(paused.threadId, 1);
        yield* use(
          Commands.decideTaskContract({
            commandId: CommandId.make("local-pause"),
            threadId: paused.threadId,
            action: "redirect",
            revision: 1,
            reviewTask: beforePause.reference,
          }),
        );
        yield* Fiber.join(stopped);
        const pausedProjection = yield* use(
          Commands.readThreadProjection({ threadId: paused.threadId }),
        );
        NodeAssert.equal(pausedProjection.thread.taskContractPhase, "redirected");
        NodeAssert.ok(["interrupted", "cancelled"].includes(pausedProjection.runs[0]!.status));
        NodeAssert.ok(
          pausedProjection.providerTurns.some(
            (turn) => turn.status === "interrupted" && turn.terminationConfirmed,
          ),
        );
        const edit = yield* reviewFor(paused.threadId, 1);
        NodeAssert.equal(edit.canEditInstructions, true);
        yield* use(
          Commands.decideTaskContract({
            commandId: CommandId.make("local-edit-paused"),
            threadId: paused.threadId,
            action: "set",
            expectedRevision: 1,
            reviewTask: edit.reference,
            goal: "Revised local instructions",
            redirect: edit.contract.redirect,
            acceptance: edit.contract.acceptance,
            brake: edit.contract.brake,
          }),
        );
        const resume = yield* reviewFor(paused.threadId, 2);
        NodeAssert.equal(resume.phase, "redirected");
        NodeAssert.deepEqual(resume.contract.brake, edit.contract.brake);
        yield* use(
          Commands.decideTaskContract({
            commandId: CommandId.make("local-explicit-resume"),
            threadId: paused.threadId,
            action: "resume",
            revision: 2,
            reviewTask: resume.reference,
          }),
        );
        NodeAssert.equal(starts().length, baseline + 1, "Edit and Resume never start work");
        const resumed = yield* use(Commands.readThreadProjection({ threadId: paused.threadId }));
        NodeAssert.equal(resumed.thread.taskContractPhase, "active");
        NodeAssert.equal(resumed.runs.length, 1);
        const direct = yield* prepare("direct-stop");
        const directRun = yield* startHeld(direct);
        const directStopped = yield* terminal(direct.threadId, direct.marker.messageId);
        yield* use(
          Commands.interruptThreadTurn({
            commandId: CommandId.make("local-direct-stop"),
            threadId: direct.threadId,
            runId: directRun.id,
          }),
        );
        yield* Fiber.join(directStopped);
        const directProjection = yield* use(
          Commands.readThreadProjection({ threadId: direct.threadId }),
        );
        NodeAssert.ok(["interrupted", "cancelled"].includes(directProjection.runs[0]!.status));
        NodeAssert.equal(directProjection.thread.taskAcceptedRevision, null);
        yield* prepare("restart-unstarted", false);
        NodeAssert.equal(starts().length, baseline + 2, "Review and creation never start work");
        NodeFS.writeFileSync(
          NodePath.join(evidence, "production-lifecycle.json"),
          encodeJson({
            environmentId,
            providerStartsBefore: baseline,
            providerStartsAfter: starts().length,
            paused: pausedProjection,
            resumed,
            directStopped: directProjection,
            unstarted:
              "Original start retained without dispatch; restart recovery must remain UNKNOWN",
          }),
        );
        yield* Effect.log(
          encodeJson({
            lifecycle: "passed",
            providerStarts: starts().length,
            pauseCancellation: "confirmed",
            resumeStarts: 0,
            directStop: "confirmed",
            unstartedOriginal: "retained without dispatch",
          }),
        );
        return;
      }
      if (!process.argv.includes("--journey")) return;
      const originalFile = NodePath.join(root, "original-first-command.json");
      NodeFS.writeFileSync(
        NodePath.join(root, "journey-begun.json"),
        encodeJson({ at: DateTime.formatIso(yield* DateTime.now) }),
        { flag: "wx", mode: 0o600 },
      );
      NodeAssert.ok(
        !NodeFS.existsSync(originalFile),
        "Original identity exists; use read-only recovery, never rerun this journey on the same root",
      );
      const projectId = ProjectId.make("local-product-project");
      yield* use(
        Commands.createProject({
          commandId: CommandId.make("local-project-create"),
          projectId,
          title: "LOCAL product verification",
          workspaceRoot: NodePath.join(root, "project"),
        }),
      );
      NodeAssert.equal(starts().length, 0);
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "fixture-manual",
      };
      const saved = yield* use(
        Commands.writeConfiguration({
          type: "profile.save",
          commandId: "local-config-save",
          projectId,
          expectedVersion: 0,
          draft: {
            id: "local-task-input",
            displayName: "Local reviewed configuration",
            description: "Reusable fixture input",
            purpose: "Bounded local verification",
            responsibilities: [],
            exclusions: [],
            instructions: "Use only deterministic local fixture behavior.",
            requiredOutputSections: ["Result"],
            artifactKind: "task-input",
            capabilityPreferences: [],
            taskConfiguration: { environmentId, modelSelection },
          },
        }),
      );
      const profile = saved.profiles.find((profile) => profile.id === "local-task-input");
      NodeAssert.ok(profile);
      const configuration = configurationSnapshot(profile);
      NodeAssert.ok(configuration);
      const goal = "Prove the connected local task journey.";
      const text = configurationInput(profile.instructions, goal);
      const threadId = ThreadId.make("local-product-task");
      const creation: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
        type: "thread.create",
        commandId: CommandId.make("local-task-create"),
        threadId,
        projectId,
        title: "LOCAL reviewed task",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        taskGovernance: "required",
        taskContract: {
          goal,
          redirect: "Use the isolated local provider only.",
          acceptance: "Owner can read two distinct correlated outputs.",
          brake: { maxProviderStarts: 4, stopConditions: "Scope or isolation changes" },
        },
        taskCreationReview: {
          environmentId,
          projectId,
          modelSelection,
          configuration,
          effectiveInstructions: text,
        },
      };
      NodeFS.writeFileSync(
        NodePath.join(root, "original-creation-command.json"),
        encodeJson(creation),
        {
          mode: 0o600,
        },
      );
      yield* use(Commands.createThread(creation));
      const task = (yield* snapshot()).tasks.find((task) => task.threadId === threadId);
      NodeAssert.ok(task);
      const review = yield* use(
        Commands.readTaskReview({
          environmentId,
          projectId,
          threadId,
          taskId: task.id,
          revision: 1,
        }),
      );
      NodeAssert.equal(review.status, "available");
      if (review.status !== "available") throw Error("Review unavailable");
      yield* use(Commands.readThreadProjection({ threadId }));
      NodeAssert.equal(starts().length, 0);
      const marker: TaskFirstLaunch = {
        commandId: CommandId.make("local-first-start"),
        messageId: MessageId.make("local-first-message"),
        threadId,
        reference: review.reference,
        contract: review.contract,
        text,
        routingMode: "manual",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
      };
      const original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
        type: "message.dispatch",
        commandId: marker.commandId,
        messageId: marker.messageId,
        threadId,
        text,
        attachments: [],
        modelSelection,
        routingMode: "manual",
        taskFirstLaunch: marker,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      };
      NodeFS.writeFileSync(originalFile, encodeJson(original), { mode: 0o600 });
      const firstTerminal = yield* terminal(threadId, marker.messageId);
      yield* use(
        Commands.startThreadTurn({
          commandId: marker.commandId,
          threadId,
          message: { messageId: marker.messageId, role: "user", text, attachments: [] },
          modelSelection,
          routingMode: "manual",
          runtimeMode: marker.runtimeMode,
          interactionMode: marker.interactionMode,
          dispatchMode: "start",
          taskFirstLaunch: marker,
        }),
      );
      yield* Fiber.join(firstTerminal);
      const firstProof = yield* use(Commands.readTaskFirstLaunchStatus({ command: original }));
      yield* Effect.log(encodeJson({ firstProof }));
      NodeAssert.equal(firstProof.status, "admitted");
      if (firstProof.status !== "admitted") throw Error("No original admission");
      NodeAssert.equal(firstProof.runStatus, "completed");
      NodeAssert.equal(starts().length, 1);
      const currentTask = (yield* snapshot()).tasks.find((task) => task.threadId === threadId);
      NodeAssert.ok(currentTask);
      const currentReview = yield* use(
        Commands.readTaskReview({
          environmentId,
          projectId,
          threadId,
          taskId: task.id,
          revision: 1,
        }),
      );
      const before = yield* use(Commands.readThreadProjection({ threadId }));
      const facts = revisionRequestFacts(currentTask, environmentId, currentReview, before);
      NodeAssert.ok(facts, "Actual native result failed attribution checks");
      const next: TaskResultContinuation = {
        ...marker,
        commandId: CommandId.make("local-next-start"),
        messageId: MessageId.make("local-next-message"),
        reference: facts.review.reference,
        contract: facts.review.contract,
        text: "Apply these exact local requested changes.",
        routingMode: "auto",
        priorResult: continuationResult(facts),
      };
      const { taskFirstLaunch: _firstLaunch, ...ordinaryOriginal } = original;
      const nextOriginal: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
        ...ordinaryOriginal,
        commandId: next.commandId,
        messageId: next.messageId,
        text: next.text,
        routingMode: "auto",
        taskResultContinuation: next,
      };
      NodeFS.writeFileSync(
        NodePath.join(root, "original-continuation-command.json"),
        encodeJson(nextOriginal),
        {
          mode: 0o600,
        },
      );
      NodeAssert.equal(starts().length, 1);
      const nextTerminal = yield* terminal(threadId, next.messageId);
      yield* use(
        Commands.startThreadTurn({
          commandId: next.commandId,
          threadId,
          message: { messageId: next.messageId, role: "user", text: next.text, attachments: [] },
          modelSelection,
          routingMode: "auto",
          runtimeMode: next.runtimeMode,
          interactionMode: next.interactionMode,
          dispatchMode: "start",
          taskResultContinuation: next,
        }),
      );
      yield* Fiber.join(nextTerminal);
      const nextProof = yield* use(
        Commands.readTaskResultContinuationStatus({ command: nextOriginal }),
      );
      yield* Effect.log(encodeJson({ nextProof }));
      NodeAssert.equal(nextProof.status, "admitted");
      if (nextProof.status !== "admitted") throw Error("No next admission");
      NodeAssert.equal(nextProof.runStatus, "completed");
      NodeAssert.notEqual(nextProof.runId, firstProof.runId);
      NodeAssert.equal(starts().length, 2);
      const after = yield* use(Commands.readThreadProjection({ threadId }));
      NodeAssert.equal(after.runs.length, 2);
      NodeAssert.deepEqual(after.thread.agentsTaskCreation, before.thread.agentsTaskCreation);
      NodeAssert.deepEqual(after.thread.taskContract, before.thread.taskContract);
      NodeAssert.equal(after.thread.taskAcceptedRevision, null);
      NodeAssert.deepEqual(
        after.turnItems.find((item) => item.id === next.priorResult.itemId),
        before.turnItems.find((item) => item.id === next.priorResult.itemId),
      );
      const acceptance = yield* use(
        Commands.readTaskReview({
          environmentId,
          projectId,
          threadId,
          taskId: task.id,
          revision: 1,
        }),
      );
      NodeAssert.equal(acceptance.status, "available");
      if (acceptance.status !== "available") throw Error("No acceptance review");
      yield* use(
        Commands.decideTaskContract({
          commandId: CommandId.make("local-explicit-accept"),
          threadId,
          action: "accept",
          revision: 1,
          reviewTask: acceptance.reference,
        }),
      );
      const accepted = yield* use(Commands.readThreadProjection({ threadId }));
      NodeAssert.equal(accepted.thread.taskAcceptedRevision, 1);
      NodeAssert.equal(starts().length, 2);
      const proof = {
        environmentId,
        projectId,
        threadId,
        configuration,
        firstProof,
        nextProof,
        starts: starts(),
        acceptedRevision: accepted.thread.taskAcceptedRevision,
        source:
          "Built production entrypoint; actual production client WS/RPC and authenticated HTTP; native deterministic fake process; no browser UI claim",
      };
      NodeFS.writeFileSync(NodePath.join(evidence, "production-journey.json"), encodeJson(proof));
      yield* Effect.log(
        encodeJson({
          journey: "passed",
          providerStarts: starts().length,
          acceptedRevision: accepted.thread.taskAcceptedRevision,
        }),
      );
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
