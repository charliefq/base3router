import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentRouterPolicyStatus,
  EnvironmentRouterPolicyCommandResult,
  HYBRID_ROUTER_POLICY_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RouterEvaluation from "./RouterEvaluationService.ts";
import { routerPolicyHttpApiLayer } from "./http.ts";
class PolicyTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.routerPolicy,
) {}
const environmentId = EnvironmentId.make("fixture-policy-environment");
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownSync(EnvironmentRouterPolicyStatus);
const decodeResult = Schema.decodeUnknownSync(EnvironmentRouterPolicyCommandResult);
const principalLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = request.headers["x-fixture-scope"];
    if (!scope)
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "fixture",
      });
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("fixture-session"),
        subject: "fixture-operator",
        method: "browser-session-cookie",
        scopes: new Set(
          scope === "operate"
            ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
            : scope === "read"
              ? [AuthOrchestrationReadScope]
              : [],
        ),
      }),
    );
  }),
);
it.effect(
  "authenticates before initialization, derives environment/actor, and rejects illegal, stale and cross-environment transitions without partial writes",
  () =>
    Effect.gen(function* () {
      const evaluation = yield* RouterEvaluation.RouterEvaluationService;
      const sql = yield* SqlClient.SqlClient;
      const environment = ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("Not used"),
      });
      const layer = HttpApiBuilder.layer(PolicyTestApi).pipe(
        Layer.provide(routerPolicyHttpApiLayer),
        Layer.provide(principalLayer),
        Layer.provide(Layer.succeed(RouterEvaluation.RouterEvaluationService, evaluation)),
        Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
        (web) =>
          Effect.gen(function* () {
            const request = (payload?: unknown, scope?: string) =>
              web.handler(
                new Request(`http://fixture/api/router-policy${payload ? "/command" : ""}`, {
                  method: payload ? "POST" : "GET",
                  headers: {
                    ...(scope ? { "x-fixture-scope": scope } : {}),
                    "content-type": "application/json",
                  },
                  ...(payload ? { body: encodeUnknownJson(payload) } : {}),
                }),
              );
            yield* Effect.promise(async () => {
              assert.equal((await request()).status, 401);
              assert.equal((await request(undefined, "none")).status, 403);
              const denied = await request(
                { action: "rollback", expectedRevision: 0, confirm: true },
                "read",
              );
              assert.equal(denied.status, 403);
            });
            assert.equal(
              (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM router_policies`)[0]
                ?.count,
              0,
            );
            yield* Effect.promise(async () => {
              const first = decodeStatus(await (await request(undefined, "read")).json());
              const candidate = first.policies.find(
                (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
              )!;
              const control = async (
                action: string,
                revision: number,
                confirm = true,
                policyId = candidate.policyId,
              ) =>
                decodeResult(
                  await (
                    await request(
                      {
                        action,
                        policyId,
                        expectedRevision: revision,
                        confirm,
                        environmentId: "forged-environment",
                        actor: "forged-actor",
                        authorized: true,
                      },
                      "operate",
                    )
                  ).json(),
                );
              assert.equal((await control("activate", first.revision)).outcome, "rejected");
              assert.equal((await control("shadow", first.revision, false)).outcome, "rejected");
              assert.equal((await control("rollback", first.revision)).outcome, "rejected");
              assert.deepEqual(
                decodeStatus(await (await request(undefined, "read")).json()),
                first,
              );
              const shadow = await control("shadow", first.revision);
              assert.equal(shadow.outcome, "applied");
              if (shadow.outcome !== "applied") return;
              assert.equal(shadow.status.active.policyId, first.active.policyId);
              assert.equal(
                shadow.status.policies.find((policy) => policy.state === "shadow")?.activatedBy,
                "fixture-operator",
              );
              assert.equal(shadow.status.environmentId, environmentId);
              const activations = await Promise.all([
                control("activate", shadow.status.revision),
                control("activate", shadow.status.revision),
              ]);
              assert.equal(activations.filter((result) => result.outcome === "applied").length, 1);
              assert.equal(activations.filter((result) => result.outcome === "rejected").length, 1);
              const active = activations.find((result) => result.outcome === "applied")!;
              assert.equal(active.outcome, "applied");
              if (active.outcome !== "applied") return;
              assert.equal(active.status.active.policyId, candidate.policyId);
              assert.equal(
                active.status.policies.filter((policy) => policy.state === "active").length,
                1,
              );
              assert.equal((await control("rollback", first.revision)).outcome, "rejected");
              assert.deepEqual(
                decodeStatus(await (await request(undefined, "read")).json()),
                active.status,
              );
              const restored = await control("rollback", active.status.revision);
              assert.equal(restored.outcome, "applied");
              if (restored.outcome !== "applied") return;
              assert.equal(restored.status.active.policyId, first.active.policyId);
              assert.equal(
                restored.status.policies.filter((policy) => policy.state === "active").length,
                1,
              );
            });
            assert.equal(
              (yield* sql<{
                count: number;
              }>`SELECT COUNT(*) AS count FROM router_policies WHERE environment_id = 'forged-environment'`)[0]
                ?.count,
              0,
            );
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(
      Effect.provide(RouterEvaluation.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
    ),
);
