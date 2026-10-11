import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CollaborationCommand,
  EnvironmentHttpApi,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  collaborationExecutionGate,
  sealCollaborationCommand,
  type CollaborationProviderFact,
} from "./admit.ts";
import { readCollaborationSnapshot, submitCollaborationCommand } from "./store.ts";

const decodeCommand = Schema.decodeUnknownEffect(CollaborationCommand);

const providerFact = (provider: ServerProvider): CollaborationProviderFact => ({
  id: provider.instanceId,
  displayName: provider.displayName ?? provider.driver,
  capabilities: provider.models.map((model) => model.slug),
  executable:
    provider.installed &&
    provider.enabled &&
    provider.status === "ready" &&
    isProviderAvailable(provider) &&
    isProviderTextGenerationCapable(provider) &&
    provider.models.length > 0,
});

export const collaborationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "collaboration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providers = yield* ProviderRegistry;

    const factsFor = (principalId: string, command: CollaborationCommand) =>
      Effect.gen(function* () {
        const projectRows = yield* projects.listShells();
        const threadRows = command.threadId
          ? yield* sql<{ readonly threadId: string; readonly projectId: string }>`
              SELECT thread_id AS threadId, project_id AS projectId
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${command.threadId}
              LIMIT 1
            `
          : [];
        const configured = yield* providers.getProviders;
        return {
          principalId,
          projectIds: projectRows.map((project) => project.id),
          providers: configured.map(providerFact),
          threads: threadRows.map((thread) => ({
            id: thread.threadId,
            projectId: thread.projectId,
          })),
          executionGate: collaborationExecutionGate,
        };
      });

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.collaboration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* readCollaborationSnapshot(sql).pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "command",
        Effect.fn("environment.collaboration.command")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const command = yield* decodeCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const sealed = yield* factsFor(principal.subject, command).pipe(
            Effect.map((facts) => sealCollaborationCommand(command, facts)),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          if (sealed.outcome === "rejected") {
            const snapshot = yield* readCollaborationSnapshot(sql).pipe(
              Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
            );
            return {
              outcome: "rejected" as const,
              code: sealed.code,
              detail: sealed.detail,
              idempotent: false,
              gateDecision: "DENY" as const,
              snapshot,
            };
          }
          return yield* submitCollaborationCommand(sql, sealed.command).pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      );
  }),
);
