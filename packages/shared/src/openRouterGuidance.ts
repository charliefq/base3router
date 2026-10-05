import {
  type DispatcherTaskRouteBinding,
  type ModelRouterCandidate,
  type ModelRouterMode,
  type ModelRouterTarget,
  type OpenRouterAgreementStatus,
  type OpenRouterCostTier,
  type OpenRouterGuidanceMode,
  type OpenRouterGuidanceSettings,
  type OpenRouterSkipReason,
  type OpenRouterTeacherObservationV0,
  DEFAULT_OPENROUTER_GUIDANCE_SETTINGS,
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_DEFAULT_GUIDANCE_MODE,
  emptyOpenRouterObservation,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { textLooksLikeSecret } from "./openRouterRedaction.ts";
import { mapEligibleCandidatesToOpenRouter } from "./openRouterIdentity.ts";

export const resolveOpenRouterGuidanceMode = (input: {
  readonly requested?: OpenRouterGuidanceMode;
  readonly settings?: OpenRouterGuidanceSettings;
  readonly credentialPresent: boolean;
}): {
  readonly mode: OpenRouterGuidanceMode;
  readonly skipReason?: OpenRouterSkipReason;
} => {
  const settings = input.settings ?? DEFAULT_OPENROUTER_GUIDANCE_SETTINGS;
  const requested = input.requested ?? settings.guidanceMode ?? OPENROUTER_DEFAULT_GUIDANCE_MODE;
  if (requested === "off") {
    return { mode: "off", skipReason: "guidance_off" };
  }
  if (!input.credentialPresent) {
    return { mode: requested, skipReason: "missing_api_key" };
  }
  if (requested === "shadow" && settings.shadowConsent !== true) {
    return { mode: "shadow", skipReason: "consent_required" };
  }
  if (requested === "teacher" && settings.teacherEnabled !== true) {
    return { mode: "teacher", skipReason: "consent_required" };
  }
  return { mode: requested };
};

export const shouldSendOpenRouterGuidance = (input: {
  readonly mode: OpenRouterGuidanceMode;
  readonly skipReason?: OpenRouterSkipReason;
}): boolean => input.skipReason === undefined && input.mode !== "off";

export const promptBlocksOpenRouterUpload = (prompt: string): OpenRouterSkipReason | null =>
  textLooksLikeSecret(prompt) ? "likely_credentials" : null;

export const openRouterAgreement = (input: {
  readonly base3Model?: string;
  readonly openRouterModel?: string;
}): OpenRouterAgreementStatus => {
  if (input.base3Model === undefined || input.openRouterModel === undefined) return "unknown";
  return input.base3Model.trim().toLowerCase() === input.openRouterModel.trim().toLowerCase()
    ? "agreement"
    : "disagreement";
};

const teacherAllowlistFromDecision = (input: {
  readonly candidates: ReadonlyArray<ModelRouterCandidate>;
  readonly costTier?: OpenRouterCostTier;
}): {
  readonly allowedModels: ReadonlyArray<string>;
  readonly empty: boolean;
  readonly unresolved: boolean;
} => {
  const mapped = mapEligibleCandidatesToOpenRouter({ candidates: input.candidates });
  return {
    allowedModels: mapped.allowedModels,
    empty: mapped.allowedModels.length === 0,
    unresolved: mapped.unresolved.length > 0,
  };
};

const emptyAllowlistSkip = (allowlist: {
  readonly empty: boolean;
  readonly unresolved: boolean;
}): OpenRouterSkipReason => (allowlist.unresolved ? "unresolved_mapping" : "empty_allowlist");

export const observationForSkip = (input: {
  readonly guidanceMode: OpenRouterGuidanceMode;
  readonly skipReason: OpenRouterSkipReason;
  readonly allowedModels?: ReadonlyArray<string>;
  readonly costTier?: OpenRouterCostTier;
  readonly base3Selected?: ModelRouterTarget;
}): OpenRouterTeacherObservationV0 => ({
  ...emptyOpenRouterObservation({
    guidanceMode: input.guidanceMode,
    status: "skipped",
    skipReason: input.skipReason,
    ...(input.allowedModels !== undefined ? { allowedModels: input.allowedModels } : {}),
    ...(input.costTier !== undefined ? { costTier: input.costTier } : {}),
  }),
  ...(input.base3Selected !== undefined ? { base3Selected: input.base3Selected } : {}),
});

export const applyOpenRouterGuidanceToBinding = (input: {
  readonly binding: DispatcherTaskRouteBinding;
  readonly requestedMode?: OpenRouterGuidanceMode;
  readonly settings?: OpenRouterGuidanceSettings;
  readonly credentialPresent: boolean;
  readonly openRouterInstanceId: ProviderInstanceId;
  readonly prompt?: string;
  readonly routingMode?: ModelRouterMode;
}): {
  readonly binding: DispatcherTaskRouteBinding;
  readonly executionTarget: ModelRouterTarget;
  readonly failed?: "teacher_unavailable" | "policy_violation" | "empty_allowlist";
} => {
  const resolved = resolveOpenRouterGuidanceMode({
    ...(input.requestedMode !== undefined ? { requested: input.requestedMode } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    credentialPresent: input.credentialPresent,
  });
  const settings = input.settings ?? DEFAULT_OPENROUTER_GUIDANCE_SETTINGS;
  const costTier = settings.costTier;
  const base3Selected = input.binding.target;
  const privacyBlock =
    input.prompt !== undefined ? promptBlocksOpenRouterUpload(input.prompt) : null;

  if (resolved.mode === "off") {
    return {
      binding: {
        ...input.binding,
        openRouter: emptyOpenRouterObservation({
          guidanceMode: "off",
          status: "not_requested",
          skipReason: "guidance_off",
          costTier,
        }),
      },
      executionTarget: input.binding.target,
    };
  }

  const candidates = input.binding.modelRoute?.candidates ?? [];
  const allowlist = teacherAllowlistFromDecision({ candidates, costTier });

  if (resolved.mode === "shadow") {
    const skipReason =
      privacyBlock ??
      resolved.skipReason ??
      (allowlist.empty ? emptyAllowlistSkip(allowlist) : undefined);
    const observation = skipReason
      ? observationForSkip({
          guidanceMode: "shadow",
          skipReason,
          allowedModels: allowlist.allowedModels,
          costTier,
          base3Selected,
        })
      : emptyOpenRouterObservation({
          guidanceMode: "shadow",
          status: "pending",
          allowedModels: allowlist.allowedModels,
          costTier,
        });
    return {
      binding: { ...input.binding, openRouter: { ...observation, base3Selected } },
      executionTarget: input.binding.target,
    };
  }

  if (input.routingMode === "manual") {
    return {
      binding: {
        ...input.binding,
        openRouter: observationForSkip({
          guidanceMode: "teacher",
          skipReason: "manual_selection",
          allowedModels: allowlist.allowedModels,
          costTier,
          base3Selected,
        }),
      },
      executionTarget: input.binding.target,
    };
  }

  const skipReason = privacyBlock ?? resolved.skipReason;
  if (skipReason !== undefined || allowlist.empty) {
    const reason = skipReason ?? emptyAllowlistSkip(allowlist);
    const observation = observationForSkip({
      guidanceMode: "teacher",
      skipReason: reason,
      allowedModels: allowlist.allowedModels,
      costTier,
      base3Selected,
    });
    return {
      binding: { ...input.binding, openRouter: observation },
      executionTarget: input.binding.target,
      failed:
        reason === "empty_allowlist" || reason === "unresolved_mapping"
          ? "empty_allowlist"
          : "teacher_unavailable",
    };
  }

  const teacherTarget: ModelRouterTarget = {
    instanceId: input.openRouterInstanceId,
    model: OPENROUTER_AUTO_SLUG,
  };
  return {
    binding: {
      ...input.binding,
      target: teacherTarget,
      driver: ProviderDriverKind.make("openrouter"),
      openRouter: {
        ...emptyOpenRouterObservation({
          guidanceMode: "teacher",
          status: "pending",
          allowedModels: allowlist.allowedModels,
          costTier,
        }),
        base3Selected,
        requestedRouterTarget: OPENROUTER_AUTO_SLUG,
      },
    },
    executionTarget: teacherTarget,
  };
};
