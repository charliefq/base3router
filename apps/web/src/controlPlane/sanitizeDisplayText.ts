import { textOmitsCursorSecrets } from "@t3tools/client-runtime/cursor-cloud";

export function sanitizeDisplayText(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.length === 0) return "";
  return textOmitsCursorSecrets(value) ? value : "[redacted]";
}
