import {
  type OpenRouterSanitizedErrorCategory,
  type ModelRouterFailureCategory,
  type ModelRouterFailureScope,
} from "@t3tools/contracts";

export type OpenRouterNormalizedError = {
  readonly category: OpenRouterSanitizedErrorCategory;
  readonly failureCategory: ModelRouterFailureCategory;
  readonly failureScope: ModelRouterFailureScope;
  readonly retryable: boolean;
};

export const normalizeOpenRouterHttpStatus = (status: number): OpenRouterNormalizedError => {
  if (status === 401) {
    return {
      category: "authentication_failed",
      failureCategory: "authentication_failed",
      failureScope: "provider_instance",
      retryable: false,
    };
  }
  if (status === 402) {
    return {
      category: "payment_required",
      failureCategory: "usage_quota_exhausted",
      failureScope: "provider_instance",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      category: "forbidden",
      failureCategory: "authentication_failed",
      failureScope: "provider_instance",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      category: "not_found",
      failureCategory: "model_unavailable",
      failureScope: "model",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      category: "rate_limited",
      failureCategory: "rate_limited",
      failureScope: "provider_instance",
      retryable: true,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      category: "transient_transport",
      failureCategory: "transient_transport",
      failureScope: "provider_instance",
      retryable: true,
    };
  }
  return {
    category: "unknown",
    failureCategory: "non_retryable_request",
    failureScope: "global",
    retryable: false,
  };
};

export const normalizeOpenRouterTransportFailure = (
  reason: "timeout" | "cancelled" | "invalid_response" | "missing_api_key",
): OpenRouterNormalizedError => {
  switch (reason) {
    case "timeout":
      return {
        category: "timeout",
        failureCategory: "transient_transport",
        failureScope: "provider_instance",
        retryable: true,
      };
    case "cancelled":
      return {
        category: "cancelled",
        failureCategory: "non_retryable_request",
        failureScope: "global",
        retryable: false,
      };
    case "missing_api_key":
      return {
        category: "missing_api_key",
        failureCategory: "authentication_failed",
        failureScope: "provider_instance",
        retryable: false,
      };
    case "invalid_response":
      return {
        category: "invalid_response",
        failureCategory: "non_retryable_request",
        failureScope: "global",
        retryable: false,
      };
  }
};
