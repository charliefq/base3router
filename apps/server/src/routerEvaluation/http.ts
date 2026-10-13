import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  annotateEnvironmentRequest,
  requireEnvironmentScope,
  failEnvironmentInternal,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RouterEvaluation from "./RouterEvaluationService.ts";

export const routerPolicyHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "routerPolicy",
  Effect.fnUntraced(function* (handlers) {
    const evaluation = yield* RouterEvaluation.RouterEvaluationService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.routerPolicy.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* evaluation
            .status(yield* environment.getEnvironmentId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "command",
        Effect.fn("environment.routerPolicy.command")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const environmentId = yield* environment.getEnvironmentId;
          const now = DateTime.formatIso(yield* DateTime.now);
          return yield* evaluation
            .control(environmentId, args.payload, now, principal.subject)
            .pipe(
              Effect.map((status) => ({ outcome: "applied" as const, status })),
              Effect.catch((error) => Effect.succeed({ outcome: "rejected" as const, error })),
            );
        }),
      );
  }),
);
