import {
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_DRIVER_KIND,
  type OpenRouterSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as TextGeneration from "./TextGeneration.ts";

import { createOpenRouterClient } from "../openRouter/OpenRouterClient.ts";
import type { OpenRouterTransport } from "../openRouter/OpenRouterTransport.ts";

export const makeOpenRouterTextGeneration = Effect.fn("makeOpenRouterTextGeneration")(function* (
  _settings: OpenRouterSettings,
  apiKey: string | undefined,
  options?: { readonly transport?: OpenRouterTransport; readonly baseUrl?: string },
) {
  const client =
    apiKey === undefined
      ? null
      : createOpenRouterClient({
          apiKey,
          ...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options?.transport !== undefined ? { transport: options.transport } : {}),
        });

  const complete = (operation: string, prompt: string, modelSelection: ModelSelection) =>
    Effect.gen(function* () {
      if (client === null) {
        return yield* new TextGenerationError({
          operation,
          detail: "OpenRouter API key is not configured.",
        });
      }
      const result = yield* Effect.tryPromise({
        try: () =>
          client.chat({
            prompt,
            allowedModels:
              modelSelection.model === OPENROUTER_AUTO_SLUG ? [] : [modelSelection.model],
            costTier: "low",
            stream: false,
            shadow: false,
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: cause instanceof Error ? cause.message : "OpenRouter text generation failed.",
          }),
      });
      if (result.status >= 400) {
        return yield* new TextGenerationError({
          operation,
          detail: "OpenRouter text generation failed.",
        });
      }
      return result.content.trim();
    });

  return {
    generateCommitMessage: (input) =>
      complete("generateCommitMessage", input.stagedSummary, input.modelSelection).pipe(
        Effect.map((subject) => ({ subject: subject.slice(0, 72), body: "" })),
      ),
    generatePrContent: (input) =>
      complete("generatePrContent", input.commitSummary, input.modelSelection).pipe(
        Effect.map((title) => ({ title: title.slice(0, 72), body: "" })),
      ),
    generateBranchName: (input) =>
      complete("generateBranchName", input.message, input.modelSelection).pipe(
        Effect.map((branch) => ({ branch: branch.slice(0, 48).replace(/\s+/g, "-") })),
      ),
    generateThreadTitle: (input) =>
      complete("generateThreadTitle", input.message, input.modelSelection).pipe(
        Effect.map((title) => ({ title: title.slice(0, 72) })),
      ),
  } satisfies TextGeneration.TextGeneration["Service"];
});

export const OPENROUTER_DRIVER = ProviderDriverKind.make(OPENROUTER_DRIVER_KIND);
