import { OPENROUTER_AUTO_SLUG } from "@t3tools/contracts";

import { actualModelIsAllowed } from "./openRouterIdentity.ts";

export type TeacherPolicyFailure = "missing_model" | "disallowed_model" | "unresolved_alias";

export type TeacherContentGate = {
  readonly verified: boolean;
  readonly failure: TeacherPolicyFailure | null;
  readonly actualModel?: string;
  readonly buffered: string;
};

export const emptyTeacherContentGate = (): TeacherContentGate => ({
  verified: false,
  failure: null,
  buffered: "",
});

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Auto Router identity is not trustworthy until OpenRouter names a concrete
 * model other than `openrouter/auto`. Official streaming docs put
 * `openrouter_metadata` on the terminal chunk; earlier `model` fields may
 * still be the router slug.
 */
export const isTrustworthyActualModel = (model: string | undefined): model is string => {
  if (model === undefined) return false;
  const trimmed = model.trim();
  return trimmed.length > 0 && normalize(trimmed) !== normalize(OPENROUTER_AUTO_SLUG);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

export const selectedModelFromMetadata = (metadata: unknown): string | undefined => {
  const record = asRecord(metadata);
  if (record === null) return undefined;
  const attempts = Array.isArray(record.attempts)
    ? record.attempts
    : asRecord(record.endpoints)?.available;
  if (!Array.isArray(attempts)) return undefined;
  const selected = attempts.find((entry) => asRecord(entry)?.selected === true);
  const fallback = attempts.find((entry) => {
    const item = asRecord(entry);
    return item !== null && item.status === 200 && typeof item.model === "string";
  });
  const candidate = asRecord(selected ?? fallback)?.model;
  return typeof candidate === "string" ? candidate : undefined;
};

export const applyTeacherContentChunk = (input: {
  readonly gate: TeacherContentGate;
  readonly allowedModels: ReadonlyArray<string>;
  readonly model?: string;
  readonly metadataModel?: string;
  readonly contentDelta: string;
  readonly terminal: boolean;
}): {
  readonly gate: TeacherContentGate;
  readonly emit: string;
} => {
  if (input.gate.failure !== null) {
    return { gate: input.gate, emit: "" };
  }
  if (input.gate.verified) {
    return { gate: { ...input.gate, buffered: "" }, emit: input.contentDelta };
  }

  const candidate = isTrustworthyActualModel(input.model)
    ? input.model.trim()
    : isTrustworthyActualModel(input.metadataModel)
      ? input.metadataModel.trim()
      : undefined;

  if (candidate !== undefined) {
    if (input.allowedModels.length > 0 && actualModelIsAllowed(candidate, input.allowedModels)) {
      return {
        gate: {
          verified: true,
          failure: null,
          actualModel: candidate,
          buffered: "",
        },
        emit: input.gate.buffered + input.contentDelta,
      };
    }
    return {
      gate: {
        verified: false,
        failure: "disallowed_model",
        actualModel: candidate,
        buffered: "",
      },
      emit: "",
    };
  }

  if (!input.terminal) {
    return {
      gate: {
        ...input.gate,
        buffered: input.gate.buffered + input.contentDelta,
      },
      emit: "",
    };
  }

  const unresolved =
    input.model !== undefined && normalize(input.model) === normalize(OPENROUTER_AUTO_SLUG);
  return {
    gate: {
      verified: false,
      failure: unresolved ? "unresolved_alias" : "missing_model",
      ...(input.model !== undefined && input.model.trim().length > 0
        ? { actualModel: input.model.trim() }
        : {}),
      buffered: "",
    },
    emit: "",
  };
};
