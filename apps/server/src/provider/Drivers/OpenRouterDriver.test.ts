import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OpenRouterExecutionSettings,
  ProviderInstanceId,
  isProviderTaskExecutionCapable,
  isProviderTextGenerationCapable,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { OpenRouterDriver } from "./OpenRouterDriver.ts";

it.live.each([
  { executionEnabled: false, hasKey: true, ready: false },
  { executionEnabled: true, hasKey: false, ready: false },
  { executionEnabled: true, hasKey: true, ready: true },
])("OpenRouter local configuration readiness $executionEnabled/$hasKey", (config) =>
  Effect.scoped(
    Effect.gen(function* () {
      const instance = yield* OpenRouterDriver.create({
        instanceId: ProviderInstanceId.make("openrouter-test"),
        enabled: true,
        environment: [],
        displayName: "LOCAL/FIXTURE",
        config: yield* Schema.decodeEffect(OpenRouterExecutionSettings)({
          executionEnabled: config.executionEnabled,
          customModels: ["fixture/explicit"],
        }),
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.equal(snapshot.status, config.ready ? "ready" : "error");
      assert.equal(snapshot.models.length, config.ready ? 2 : 0);
      if (config.ready)
        assert.equal(snapshot.models[0]?.name, "OpenRouter Auto (remote model selection)");
      assert.isTrue(isProviderTaskExecutionCapable(snapshot));
      assert.isFalse(isProviderTextGenerationCapable(snapshot));
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot);
      assert.notInclude(json, "synthetic-private-key");
      assert.isTrue(json.includes("not been probed") || json.includes("save an API key"));
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () =>
            Effect.succeed(
              config.hasKey
                ? Option.some(new TextEncoder().encode("synthetic-private-key"))
                : Option.none(),
            ),
          set: () => Effect.die("must not configure credentials"),
          remove: () => Effect.die("must not change credentials"),
        }),
      ),
    ),
  ),
);
