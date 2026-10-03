import {
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_DRIVER_KIND,
  OpenRouterSettings,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenRouterTextGeneration } from "../../textGeneration/OpenRouterTextGeneration.ts";
import { resolveOpenRouterApiKey } from "../../openRouter/OpenRouterCredentials.ts";
import { makeOpenRouterAdapter } from "../Layers/OpenRouterAdapter.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const decodeOpenRouterSettings = Schema.decodeSync(OpenRouterSettings);
const DRIVER_KIND = ProviderDriverKind.make(OPENROUTER_DRIVER_KIND);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const PRESENTATION = {
  displayName: "OpenRouter",
  supportsConversationRollback: false,
  badgeLabel: "Teacher/Shadow",
  showInteractionModeToggle: false,
} as const;

export type OpenRouterDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | ServerSettingsService;

const buildSnapshot = (
  settings: OpenRouterSettings,
  apiKeyPresent: boolean,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [
        {
          slug: OPENROUTER_AUTO_SLUG,
          name: "OpenRouter Auto",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
      probe: {
        installed: true,
        version: null,
        status: apiKeyPresent ? "ready" : "warning",
        auth: {
          status: apiKeyPresent ? "authenticated" : "unauthenticated",
          type: "api-key",
          label: apiKeyPresent ? "API key configured" : "API key missing",
        },
        ...(apiKeyPresent
          ? {}
          : { message: "Set OPENROUTER_API_KEY on this instance or the server environment." }),
      },
    });
  });

export const OpenRouterDriver: ProviderDriver<OpenRouterSettings, OpenRouterDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenRouter",
    supportsMultipleInstances: true,
  },
  configSchema: OpenRouterSettings,
  defaultConfig: (): OpenRouterSettings => decodeOpenRouterSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const apiKey = resolveOpenRouterApiKey({ environment, processEnv });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenRouterSettings;
      const adapter = yield* makeOpenRouterAdapter({
        instanceId,
        apiKey,
        ...(effectiveConfig.apiEndpoint.trim().length > 0
          ? { baseUrl: effectiveConfig.apiEndpoint }
          : {}),
      });
      const textGeneration = yield* makeOpenRouterTextGeneration(effectiveConfig, apiKey);
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenRouterSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          buildSnapshot(effectiveConfig, apiKey !== undefined).pipe(Effect.map(stampIdentity)),
        checkProvider: buildSnapshot(effectiveConfig, apiKey !== undefined).pipe(
          Effect.map(stampIdentity),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenRouter snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const instance: ProviderInstance = {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        ...(accentColor !== undefined ? { accentColor } : {}),
        enabled,
        snapshot,
        adapter,
        textGeneration,
      };
      return instance;
    }),
};
