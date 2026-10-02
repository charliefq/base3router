// @effect-diagnostics globalTimers:off preferSchemaOverJson:off - Promise transport with injectable fetch and JSON bodies.
import {
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OPENROUTER_CLASSIFICATIONS_PATH,
  OPENROUTER_CLASSIFICATION_WINDOW,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_CATALOG_PAGE_SIZE,
  OPENROUTER_CATALOG_PAGE_SIZE_MAX,
  OPENROUTER_MODELS_PATH,
  OPENROUTER_REQUEST_TIMEOUT_MS,
  type OpenRouterCostTier,
} from "@t3tools/contracts";
import {
  openRouterMetadataHeaders,
  openRouterShadowRequestBody,
  openRouterTeacherRequestBody,
} from "@t3tools/shared/openRouterPrivacy";
import { nextModelsPageOffset } from "@t3tools/shared/openRouterMarketPriors";
import {
  applyTeacherContentChunk,
  emptyTeacherContentGate,
  selectedModelFromMetadata,
  type TeacherContentGate,
  type TeacherPolicyFailure,
} from "@t3tools/shared/openRouterTeacherGate";

import {
  fetchOpenRouterTransport,
  type OpenRouterTransport,
  type OpenRouterTransportResponse,
} from "./OpenRouterTransport.ts";

export type OpenRouterClientConfig = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly transport?: OpenRouterTransport;
  readonly timeoutMs?: number;
};

export type OpenRouterChatResult = {
  readonly status: number;
  readonly model?: string;
  readonly content: string;
  readonly metadata?: unknown;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly cost?: number;
  };
  readonly rawError?: string;
  readonly policyFailure?: TeacherPolicyFailure;
};

const headerRecord = (apiKey: string, extra?: Readonly<Record<string, string>>) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  ...openRouterMetadataHeaders(),
  ...extra,
});

const origin = (baseUrl: string | undefined): string =>
  (baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, "");

const withTimeout = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const onAbort = () => controller.abort(external?.reason ?? "cancelled");
  external?.addEventListener("abort", onAbort, { once: true });
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const readUsage = (raw: unknown): OpenRouterChatResult["usage"] => {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = (raw as { readonly usage?: Record<string, unknown> }).usage;
  if (usage === undefined) return undefined;
  return {
    ...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { completionTokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
  };
};

const readContent = (raw: unknown): string => {
  if (raw === null || typeof raw !== "object") return "";
  const choices = (raw as { readonly choices?: ReadonlyArray<Record<string, unknown>> }).choices;
  const message = choices?.[0]?.message;
  if (message !== null && typeof message === "object") {
    const content = (message as { readonly content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  const delta = choices?.[0]?.delta;
  if (delta !== null && typeof delta === "object") {
    const content = (delta as { readonly content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
};

const readModel = (raw: unknown): string | undefined => {
  if (raw === null || typeof raw !== "object") return undefined;
  const model = (raw as { readonly model?: unknown }).model;
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
};

const readMetadata = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== "object") return undefined;
  return (raw as { readonly openrouter_metadata?: unknown }).openrouter_metadata;
};

const mergeChatJson = (raw: unknown, previous: OpenRouterChatResult): OpenRouterChatResult => {
  const content = readContent(raw);
  const model = readModel(raw) ?? previous.model;
  const metadata = readMetadata(raw) ?? previous.metadata;
  const usage = readUsage(raw) ?? previous.usage;
  return {
    status: previous.status,
    content: previous.content + content,
    ...(model !== undefined ? { model } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
};

const parseSseFrames = (
  buffer: string,
): { readonly frames: ReadonlyArray<string>; readonly rest: string } => {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n\n");
    if (index === -1) break;
    frames.push(rest.slice(0, index));
    rest = rest.slice(index + 2);
  }
  return { frames, rest };
};

const ssePayload = (frame: string): string | null => {
  const lines = frame.split("\n");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (data.length === 0 || data === "[DONE]") return null;
  return data;
};

export const createOpenRouterClient = (config: OpenRouterClientConfig) => {
  const transport = config.transport ?? fetchOpenRouterTransport;
  const timeoutMs = config.timeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS;
  const base = origin(config.baseUrl);

  const request = (
    input: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: string;
      readonly query?: string;
    },
    signal?: AbortSignal,
  ) =>
    withTimeout(
      (timeoutSignal) =>
        transport({
          method: input.method,
          url: `${base}${input.path}${input.query ?? ""}`,
          headers: headerRecord(config.apiKey),
          ...(input.body !== undefined ? { body: input.body } : {}),
          signal: timeoutSignal,
        }),
      timeoutMs,
      signal,
    );

  const readError = async (response: OpenRouterTransportResponse): Promise<string> => {
    const text = await response.text();
    const parsed = parseJson(text);
    if (parsed !== null && typeof parsed === "object") {
      const error = (parsed as { readonly error?: { readonly message?: unknown } }).error;
      if (typeof error?.message === "string") return error.message;
    }
    return text.slice(0, 256);
  };

  return {
    chat: async (input: {
      readonly prompt: string;
      readonly allowedModels: ReadonlyArray<string>;
      readonly costTier: OpenRouterCostTier;
      readonly stream: boolean;
      readonly shadow: boolean;
      readonly signal?: AbortSignal;
      readonly onDelta?: (delta: string) => void;
      /**
       * Teacher fail-closed gate. Content deltas stay buffered until a
       * trustworthy actual model is identified and allowlisted. Shadow and Off
       * leave this unset so streaming is unchanged.
       */
      readonly requireAllowedActualModel?: boolean;
    }): Promise<OpenRouterChatResult> => {
      const body = input.shadow
        ? openRouterShadowRequestBody({
            prompt: input.prompt,
            allowedModels: input.allowedModels,
            costTier: input.costTier,
          })
        : openRouterTeacherRequestBody({
            prompt: input.prompt,
            allowedModels: input.allowedModels,
            costTier: input.costTier,
            stream: input.stream,
          });
      const response = await request(
        {
          method: "POST",
          path: OPENROUTER_CHAT_COMPLETIONS_PATH,
          body: JSON.stringify(body),
        },
        input.signal,
      );
      if (response.status >= 400) {
        return { status: response.status, content: "", rawError: await readError(response) };
      }

      const finishGated = (
        acc: OpenRouterChatResult,
        gate: TeacherContentGate,
        emit: string,
      ): OpenRouterChatResult => {
        if (emit.length > 0) input.onDelta?.(emit);
        if (gate.failure !== null) {
          return {
            status: acc.status,
            content: "",
            policyFailure: gate.failure,
            ...(gate.actualModel !== undefined ? { model: gate.actualModel } : {}),
            ...(acc.metadata !== undefined ? { metadata: acc.metadata } : {}),
            ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
          };
        }
        return {
          ...acc,
          ...(gate.actualModel !== undefined ? { model: gate.actualModel } : {}),
        };
      };

      if (input.stream && response.stream !== undefined) {
        let acc: OpenRouterChatResult = { status: response.status, content: "" };
        let buffer = "";
        let gate = emptyTeacherContentGate();
        for await (const chunk of response.stream()) {
          buffer += chunk.replace(/\r\n/g, "\n");
          const parsed = parseSseFrames(buffer);
          buffer = parsed.rest;
          for (const frame of parsed.frames) {
            const payload = ssePayload(frame);
            if (payload === null) continue;
            const json = parseJson(payload);
            const before = acc.content.length;
            acc = mergeChatJson(json, acc);
            const delta = acc.content.slice(before);
            if (input.requireAllowedActualModel === true) {
              const next = applyTeacherContentChunk({
                gate,
                allowedModels: input.allowedModels,
                model: readModel(json) ?? acc.model,
                metadataModel: selectedModelFromMetadata(readMetadata(json) ?? acc.metadata),
                contentDelta: delta,
                terminal: false,
              });
              gate = next.gate;
              if (next.emit.length > 0) input.onDelta?.(next.emit);
              if (gate.failure !== null) {
                return finishGated(acc, gate, "");
              }
            } else if (delta.length > 0) {
              input.onDelta?.(delta);
            }
          }
        }
        if (input.requireAllowedActualModel === true) {
          const next = applyTeacherContentChunk({
            gate,
            allowedModels: input.allowedModels,
            model: acc.model,
            metadataModel: selectedModelFromMetadata(acc.metadata),
            contentDelta: "",
            terminal: true,
          });
          return finishGated(acc, next.gate, next.emit);
        }
        return acc;
      }
      const text = await response.text();
      const json = parseJson(text);
      const merged = mergeChatJson(json, { status: response.status, content: "" });
      if (input.requireAllowedActualModel === true) {
        const next = applyTeacherContentChunk({
          gate: emptyTeacherContentGate(),
          allowedModels: input.allowedModels,
          model: merged.model,
          metadataModel: selectedModelFromMetadata(merged.metadata),
          contentDelta: merged.content,
          terminal: true,
        });
        return finishGated(merged, next.gate, next.emit);
      }
      if (merged.content.length > 0) input.onDelta?.(merged.content);
      return merged;
    },
    listModels: async (
      signal?: AbortSignal,
    ): Promise<{ readonly status: number; readonly data: unknown[] }> => {
      const data: unknown[] = [];
      let offset = 0;
      const pageLimit = Math.min(OPENROUTER_CATALOG_PAGE_SIZE, OPENROUTER_CATALOG_PAGE_SIZE_MAX);
      for (;;) {
        const response = await request(
          {
            method: "GET",
            path: OPENROUTER_MODELS_PATH,
            query: `?offset=${offset}&limit=${pageLimit}`,
          },
          signal,
        );
        if (response.status >= 400) return { status: response.status, data };
        const json = parseJson(await response.text());
        const page = Array.isArray((json as { readonly data?: unknown })?.data)
          ? (json as { readonly data: unknown[] }).data
          : Array.isArray(json)
            ? json
            : [];
        data.push(...page);
        const next = nextModelsPageOffset({
          offset,
          limit: pageLimit,
          pageLength: page.length,
        });
        if (next === null) return { status: 200, data };
        offset = next;
      }
    },
    classifications: async (
      signal?: AbortSignal,
    ): Promise<{ readonly status: number; readonly data: unknown }> => {
      const response = await request(
        {
          method: "GET",
          path: OPENROUTER_CLASSIFICATIONS_PATH,
          query: `?window=${OPENROUTER_CLASSIFICATION_WINDOW}`,
        },
        signal,
      );
      const json = parseJson(await response.text());
      return { status: response.status, data: json };
    },
  };
};

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;
