import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CollaborationCommand,
  EnvironmentHttpApi,
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
import { readCollaborationSnapshot, submitCollaborationCommand } from "./store.ts";

const decodeCommand = Schema.decodeUnknownEffect(CollaborationCommand);

export const collaborationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "collaboration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;

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
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const command = yield* decodeCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* submitCollaborationCommand(sql, command).pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      );
  }),
);
