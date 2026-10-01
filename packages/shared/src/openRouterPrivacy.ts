import {
  type OpenRouterCostTier,
  OPENROUTER_AUTO_ROUTER_PLUGIN_ID,
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_METADATA_HEADER,
  OPENROUTER_METADATA_HEADER_VALUE,
  OPENROUTER_PHASE10_PRIVACY_POLICY,
  OPENROUTER_SHADOW_MAX_TOKENS,
} from "@t3tools/contracts";

export const OPENROUTER_PRIVACY_PROVIDER_PREFERENCES = {
  zdr: true,
  data_collection: "deny",
} as const;

export type OpenRouterAutoRouterPlugin = {
  readonly id: typeof OPENROUTER_AUTO_ROUTER_PLUGIN_ID;
  readonly allowed_models: ReadonlyArray<string>;
  readonly excluded_models?: ReadonlyArray<string>;
  readonly cost_tier: OpenRouterCostTier;
};

export type OpenRouterChatRequestBody = {
  readonly model: typeof OPENROUTER_AUTO_SLUG;
  readonly messages: ReadonlyArray<{ readonly role: "user"; readonly content: string }>;
  readonly stream: boolean;
  readonly provider: typeof OPENROUTER_PRIVACY_PROVIDER_PREFERENCES;
  readonly plugins: readonly [OpenRouterAutoRouterPlugin];
  readonly max_tokens?: number;
};

export const openRouterMetadataHeaders = (): Readonly<Record<string, string>> => ({
  [OPENROUTER_METADATA_HEADER]: OPENROUTER_METADATA_HEADER_VALUE,
});

export const openRouterAutoRouterPlugin = (input: {
  readonly allowedModels: ReadonlyArray<string>;
  readonly excludedModels?: ReadonlyArray<string>;
  readonly costTier: OpenRouterCostTier;
}): OpenRouterAutoRouterPlugin => ({
  id: OPENROUTER_AUTO_ROUTER_PLUGIN_ID,
  allowed_models: [...input.allowedModels],
  ...(input.excludedModels !== undefined && input.excludedModels.length > 0
    ? { excluded_models: [...input.excludedModels] }
    : {}),
  cost_tier: input.costTier,
});

export const openRouterTeacherRequestBody = (input: {
  readonly prompt: string;
  readonly allowedModels: ReadonlyArray<string>;
  readonly costTier: OpenRouterCostTier;
  readonly stream: boolean;
}): OpenRouterChatRequestBody => ({
  model: OPENROUTER_AUTO_SLUG,
  messages: [{ role: "user", content: input.prompt }],
  stream: input.stream,
  provider: OPENROUTER_PRIVACY_PROVIDER_PREFERENCES,
  plugins: [
    openRouterAutoRouterPlugin({ allowedModels: input.allowedModels, costTier: input.costTier }),
  ],
});

export const openRouterShadowRequestBody = (input: {
  readonly prompt: string;
  readonly allowedModels: ReadonlyArray<string>;
  readonly costTier: OpenRouterCostTier;
}): OpenRouterChatRequestBody => ({
  ...openRouterTeacherRequestBody({
    prompt: input.prompt,
    allowedModels: input.allowedModels,
    costTier: input.costTier,
    stream: false,
  }),
  max_tokens: OPENROUTER_SHADOW_MAX_TOKENS,
});

export const openRouterRequestOmitsPluginsAndTools = (body: OpenRouterChatRequestBody): boolean => {
  const pluginIds = body.plugins.map((plugin) => plugin.id);
  return (
    pluginIds.length === 1 &&
    pluginIds[0] === OPENROUTER_AUTO_ROUTER_PLUGIN_ID &&
    !("tools" in body) &&
    !("tool_choice" in body)
  );
};

export const openRouterPhase10PrivacyPolicy = OPENROUTER_PHASE10_PRIVACY_POLICY;
