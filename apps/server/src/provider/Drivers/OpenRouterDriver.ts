import {
  OpenRouterExecutionSettings,
  ProviderSetupError,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  makeOpenRouterAdapter,
  OPENROUTER_DRIVER,
} from "../../orchestration-v2/Adapters/OpenRouterAdapterV2.ts";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderAuthFlow from "../ProviderAuthFlow.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";

export type OpenRouterDriverEnv = ServerSecretStore.ServerSecretStore | Crypto.Crypto;
const decode = Schema.decodeSync(OpenRouterExecutionSettings);

export const OpenRouterDriver: ProviderDriver<OpenRouterExecutionSettings, OpenRouterDriverEnv> = {
  driverKind: OPENROUTER_DRIVER,
  metadata: { displayName: "OpenRouter (text)", supportsMultipleInstances: true },
  configSchema: OpenRouterExecutionSettings,
  defaultConfig: () => decode({}),
  create: ({ instanceId, enabled, config, displayName, accentColor }) =>
    Effect.gen(function* () {
      const store = yield* ProviderCredentialStore.make("openrouter", instanceId);
      // No ambient environment key: guidance credentials never confer execution access.
      const apiKey = store.get.pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const models = [
        ...new Set([
          "openrouter/auto",
          ...config.customModels.map((entry) => (typeof entry === "string" ? entry : entry.slug)),
        ]),
      ].filter((slug) => /^[\w./:@+-]{1,256}$/.test(slug));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: OPENROUTER_DRIVER,
        instanceId,
      });
      const getSnapshot = Effect.gen(function* () {
        const configured = enabled && config.executionEnabled && (yield* apiKey) !== null;
        return {
          instanceId,
          driver: OPENROUTER_DRIVER,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled,
          installed: true,
          version: null,
          status: !enabled ? "disabled" : configured ? "ready" : "error",
          auth: { status: configured ? "authenticated" : "unauthenticated" },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          message: configured
            ? "Text execution configured; credentials have not been probed. OpenRouter Auto selects remotely; B3R heuristic Auto excludes this provider."
            : "Enable text execution and save an API key in Settings > Providers. No provider requests are made until a task is explicitly sent.",
          supportsTextGeneration: false,
          supportsTextTasks: true,
          supportsConversationRollback: false,
          showInteractionModeToggle: false,
          setup: {
            canAuthenticate: true,
            canInstall: false,
            documentationUrl: "https://openrouter.ai/docs/quickstart",
          },
          models: configured
            ? models.map((slug) => ({
                slug,
                name:
                  slug === "openrouter/auto" ? "OpenRouter Auto (remote model selection)" : slug,
                isCustom: slug !== "openrouter/auto",
                isDefault: slug === "openrouter/auto",
                capabilities: null,
                inputModalities: ["text"],
              }))
            : [],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const refresh = getSnapshot.pipe(Effect.tap((snapshot) => PubSub.publish(changes, snapshot)));
      const setupError = () =>
        new ProviderSetupError({
          instanceId,
          operation: "authenticate",
          detail: "Unable to save OpenRouter credentials. Retry in provider settings.",
        });
      const auth = yield* ProviderAuthFlow.make({
        instanceId,
        credentialBinding: store.binding,
        methods: Effect.succeed([
          {
            id: "api-key",
            name: "Save API key (no probe)",
            description:
              "Stored only in this environment's secret store. Saving does not verify access or spend limits.",
            type: "credentials",
          },
        ]),
        authenticate: (_method, context) =>
          Effect.gen(function* () {
            const key = yield* Deferred.make<string>();
            yield* context.setInteraction(
              {
                type: "credentials",
                id: "api-key",
                fields: [{ name: "apiKey", label: "OpenRouter API key", secret: true }],
              },
              (response) =>
                response.type === "credentials" &&
                typeof response.values.apiKey === "string" &&
                /^[!-~]{1,4096}$/.test(response.values.apiKey)
                  ? Deferred.succeed(key, response.values.apiKey).pipe(Effect.asVoid)
                  : Effect.fail(setupError()),
            );
            const value = yield* Deferred.await(key);
            yield* store.set(new TextEncoder().encode(value)).pipe(Effect.mapError(setupError));
            yield* refresh;
          }),
        logout: store.remove.pipe(
          Effect.tap(() => refresh),
          Effect.mapError(setupError),
        ),
      });
      const unavailable = (
        operation:
          | "generateCommitMessage"
          | "generatePrContent"
          | "generateBranchName"
          | "generateThreadTitle",
      ) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "OpenRouter is available only for explicitly dispatched text tasks.",
          }),
        );
      return {
        instanceId,
        driverKind: OPENROUTER_DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth,
        snapshot: {
          resolveMaintenance: () =>
            Effect.succeed({ provider: OPENROUTER_DRIVER, packageName: null, update: null }),
          getSnapshot,
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
        },
        orchestrationAdapter: makeOpenRouterAdapter({
          instanceId,
          enabled: enabled && config.executionEnabled,
          models,
          apiKey,
        }),
        textGeneration: {
          generateCommitMessage: () => unavailable("generateCommitMessage"),
          generatePrContent: () => unavailable("generatePrContent"),
          generateBranchName: () => unavailable("generateBranchName"),
          generateThreadTitle: () => unavailable("generateThreadTitle"),
        },
      };
    }),
};
