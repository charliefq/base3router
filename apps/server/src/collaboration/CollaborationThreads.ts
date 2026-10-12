import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ThreadId,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type CollaborationCommandResult,
  type CollaborationOpenThreadInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  CommandReceiptStoreV2,
  layer as receiptLayer,
} from "../orchestration-v2/CommandReceiptStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import {
  bindingConflict,
  ownedCommands,
  readCommands,
  readCollaborationSnapshot,
  submitCollaborationCommand,
} from "./store.ts";
import { collaborationExecutionGate, sealCollaborationCommand } from "./admit.ts";

export class CollaborationThreadsError extends Schema.TaggedError<CollaborationThreadsError>()(
  "CollaborationThreadsError",
  { cause: Schema.Defect() },
) {}

export class CollaborationThreads extends Context.Service<
  CollaborationThreads,
  {
    readonly open: (
      principalId: string,
      input: CollaborationOpenThreadInput,
    ) => Effect.Effect<CollaborationCommandResult, CollaborationThreadsError>;
  }
>()("t3/collaboration/CollaborationThreads") {}

// No client-provided id can choose another principal's receipt or thread.
const collaborationThreadIdentity = (
  environmentId: string,
  principalId: string,
  projectId: string,
  providerId: string,
) => {
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        "collaboration-thread-v1",
        environmentId,
        principalId,
        projectId,
        providerId,
      ]),
    )
    .digest("hex");
  return {
    threadId: ThreadId.make(`collaboration:${digest}`),
    commandId: CommandId.make(`collaboration:create:${digest}`),
    bindCommandId: `collaboration:bind:${digest}`,
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const receipts = yield* CommandReceiptStoreV2;
  const projects = yield* ProjectStoreV2;
  const providers = yield* ProviderRegistry;
  const environment = yield* ServerEnvironment;
  const open = Effect.fn("collaboration.openOrRecover")(function* (
    principalId: string,
    input: CollaborationOpenThreadInput,
  ) {
    const refuse = (detail: string) =>
      Effect.map(readCollaborationSnapshot(sql, principalId), (snapshot) => ({
        outcome: "rejected" as const,
        code: "identity-conflict" as const,
        detail,
        idempotent: false,
        gateDecision: "DENY" as const,
        snapshot,
      }));
    if (!principalId.trim()) return yield* refuse("An authenticated principal is required.");
    const project = yield* projects.getShell(ProjectId.make(input.projectId));
    const configured = yield* providers.getProviders;
    const provider = configured.find((item) => item.instanceId === input.providerId);
    if (
      Option.isNone(project) ||
      !provider ||
      !provider.installed ||
      !provider.enabled ||
      provider.status !== "ready" ||
      !isProviderAvailable(provider) ||
      !isProviderTextGenerationCapable(provider) ||
      !provider.models.length
    )
      return yield* refuse("The project or provider is unavailable. No conversation was opened.");
    const commands = yield* readCommands(sql);
    if (bindingConflict(commands, principalId, input.projectId, input.providerId))
      return yield* refuse(
        "The binding has unknown or conflicting ownership. It requires explicit repair.",
      );
    const existing = ownedCommands(commands, principalId).find(
      (item) =>
        item.type === "thread.bind" &&
        item.projectId === input.projectId &&
        item.agentId === input.providerId,
    );
    const identity = collaborationThreadIdentity(
      yield* environment.getEnvironmentId,
      principalId,
      input.projectId,
      input.providerId,
    );
    const threadId = existing?.threadId ? ThreadId.make(existing.threadId) : identity.threadId;
    const receipt = yield* receipts.getByCommandId(identity.commandId);
    const readThread = () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
        if (rows.length === 0) return Option.none();
        return Option.some((yield* threads.getThreadProjection(threadId)).thread);
      });
    let snapshot = yield* readThread();
    if (existing && Option.isNone(snapshot))
      return yield* refuse("The linked thread is missing. Explicit repair is required.");
    if (
      !existing &&
      Option.isSome(snapshot) &&
      (Option.isNone(receipt) ||
        receipt.value.status !== "accepted" ||
        receipt.value.commandType !== "thread.create" ||
        receipt.value.threadId !== threadId)
    )
      return yield* refuse(
        "The thread identity has no matching create receipt. Explicit repair is required.",
      );
    if (Option.isSome(snapshot)) {
      const thread = snapshot.value;
      if (
        thread.projectId !== input.projectId ||
        thread.providerInstanceId !== input.providerId ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      )
        return yield* refuse(
          "The linked thread is invalid or archived. Explicit repair is required.",
        );
    } else {
      // An accepted receipt without its thread is not permission to recreate deleted data.
      if (Option.isSome(receipt))
        return yield* refuse(
          "A prior create receipt has no recoverable thread. Explicit repair is required.",
        );
      const model = provider.models.find((item) => item.isDefault) ?? provider.models[0]!;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: identity.commandId,
        threadId,
        projectId: ProjectId.make(input.projectId),
        title: `Chat with ${provider.displayName ?? provider.driver}`,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      snapshot = yield* readThread();
      if (Option.isNone(snapshot))
        return yield* refuse("Thread creation has not been confirmed. Retry this project.");
    }
    if (existing)
      return {
        outcome: "applied" as const,
        code: null,
        detail: "The existing conversation was recovered.",
        idempotent: true,
        gateDecision: "DENY" as const,
        snapshot: yield* readCollaborationSnapshot(sql, principalId),
      };
    const confirmedReceipt = yield* receipts.getByCommandId(identity.commandId);
    if (
      Option.isNone(confirmedReceipt) ||
      confirmedReceipt.value.status !== "accepted" ||
      confirmedReceipt.value.commandType !== "thread.create" ||
      confirmedReceipt.value.threadId !== threadId
    )
      return yield* refuse("The scoped create receipt could not be confirmed. Retry this project.");
    const sealed = sealCollaborationCommand(
      {
        type: "thread.bind",
        commandId: identity.bindCommandId,
        projectId: input.projectId,
        agentId: input.providerId,
        threadId,
      },
      {
        principalId,
        projectIds: [input.projectId],
        providers: [
          {
            id: provider.instanceId,
            displayName: provider.displayName ?? provider.driver,
            capabilities: provider.models.map((model) => model.slug),
            executable: true,
          },
        ],
        threads: [{ id: threadId, projectId: input.projectId }],
        executionGate: collaborationExecutionGate,
      },
    );
    if (sealed.outcome === "rejected") return yield* refuse(sealed.detail);
    return yield* submitCollaborationCommand(sql, sealed.command, { allowNewBinding: true });
  });
  return CollaborationThreads.of({
    open: (principalId, input) =>
      open(principalId, input).pipe(
        Effect.mapError((cause) => new CollaborationThreadsError({ cause })),
      ),
  });
});

export const layer = Layer.effect(CollaborationThreads, make).pipe(Layer.provide(receiptLayer));
