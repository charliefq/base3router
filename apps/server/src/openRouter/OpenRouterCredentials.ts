import {
  OPENROUTER_API_KEY_ENV,
  type OpenRouterCapabilitySnapshot,
  type OpenRouterGuidanceSettings,
  DEFAULT_OPENROUTER_GUIDANCE_SETTINGS,
  OPENROUTER_DEFAULT_GUIDANCE_MODE,
  OPENROUTER_PHASE10_PRIVACY_POLICY,
  OPENROUTER_DEFAULT_COST_TIER,
} from "@t3tools/contracts";
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export const resolveOpenRouterApiKey = (input: {
  readonly environment?: ProviderInstanceEnvironment;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly providerInstances?: Readonly<
    Record<string, { readonly environment?: ProviderInstanceEnvironment }>
  >;
}): string | undefined => {
  const fromInstance = input.environment?.find(
    (entry) => entry.name === OPENROUTER_API_KEY_ENV,
  )?.value;
  if (typeof fromInstance === "string" && fromInstance.trim().length > 0) {
    return fromInstance.trim();
  }
  if (input.providerInstances !== undefined) {
    for (const instance of Object.values(input.providerInstances)) {
      const mapped = instance.environment?.find(
        (entry) => entry.name === OPENROUTER_API_KEY_ENV,
      )?.value;
      if (typeof mapped === "string" && mapped.trim().length > 0) {
        return mapped.trim();
      }
    }
  }
  const fromProcess = (input.processEnv ?? process.env)[OPENROUTER_API_KEY_ENV];
  const value = fromProcess?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
};

export const openRouterCapabilitySnapshot = (input: {
  readonly settings?: OpenRouterGuidanceSettings;
  readonly credentialPresent: boolean;
  readonly marketPriorFreshness?: OpenRouterCapabilitySnapshot["marketPriorFreshness"];
  readonly marketPriorAsOf?: string;
}): OpenRouterCapabilitySnapshot => {
  const settings = input.settings ?? DEFAULT_OPENROUTER_GUIDANCE_SETTINGS;
  return {
    available: input.credentialPresent,
    guidanceModes: ["off", "shadow", "teacher"],
    credentialStatus: input.credentialPresent ? "configured" : "missing",
    connectionStatus: input.credentialPresent ? "connected" : "not_configured",
    configuredGuidanceMode: settings.guidanceMode ?? OPENROUTER_DEFAULT_GUIDANCE_MODE,
    privacyPolicy: OPENROUTER_PHASE10_PRIVACY_POLICY,
    shadowConsent: settings.shadowConsent === true,
    teacherFallbackToBase3: settings.teacherFallbackToBase3 !== false,
    costTier: settings.costTier ?? OPENROUTER_DEFAULT_COST_TIER,
    marketPriorFreshness: input.marketPriorFreshness ?? "unknown",
    ...(input.marketPriorAsOf !== undefined ? { marketPriorAsOf: input.marketPriorAsOf } : {}),
  };
};
