import {
  type OpenRouterInternalAttempt,
  type OpenRouterRoutingMetadataSummary,
} from "@t3tools/contracts";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

const bounded = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
};

const asInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return undefined;
};

const nestedAttempt = (raw: unknown): OpenRouterInternalAttempt | null => {
  const record = asRecord(raw);
  if (record === null) return null;
  const provider = bounded(record.provider, 256);
  const model = bounded(record.model, 256);
  const status = asInt(record.status);
  return {
    origin: "openrouter_internal",
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(typeof record.selected === "boolean" ? { selected: record.selected } : {}),
  };
};

export const summarizeOpenRouterMetadata = (
  raw: unknown,
): OpenRouterRoutingMetadataSummary | undefined => {
  const record = asRecord(raw);
  if (record === null) return undefined;
  const attemptsSource = Array.isArray(record.attempts)
    ? record.attempts
    : asRecord(record.endpoints)?.available;
  const nestedAttempts = (Array.isArray(attemptsSource) ? attemptsSource : [])
    .flatMap((entry) => {
      const attempt = nestedAttempt(entry);
      return attempt === null ? [] : [attempt];
    })
    .slice(0, 16);
  const requested = bounded(record.requested, 256);
  const strategy = bounded(record.strategy, 256);
  const region = bounded(record.region, 256);
  const summary = bounded(record.summary, 512);
  const attempt = asInt(record.attempt);
  return {
    ...(requested !== undefined ? { requested } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(typeof record.is_byok === "boolean" ? { isByok: record.is_byok } : {}),
    nestedAttempts,
  };
};
