const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|OPENROUTER_API_KEY\s*=|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

export const OPENROUTER_SECRET_REDACTION = "[redacted]";

export const openRouterSecretPattern = (): RegExp => new RegExp(SECRET_SHAPED.source, "i");

export const textLooksLikeSecret = (value: string): boolean => SECRET_SHAPED.test(value);

export const redactOpenRouterSecrets = (value: string): string =>
  SECRET_SHAPED.test(value) ? OPENROUTER_SECRET_REDACTION : value;

export const serializedOmitsSecrets = (value: unknown): boolean => {
  if (typeof value === "string") return !SECRET_SHAPED.test(value);
  if (Array.isArray(value)) return value.every(serializedOmitsSecrets);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) =>
        !/authorization|api[_-]?key|secret|token/i.test(key) && serializedOmitsSecrets(entry),
    );
  }
  return true;
};
