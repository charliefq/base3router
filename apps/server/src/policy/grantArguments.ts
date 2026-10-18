// Grant digests are canonical JSON persisted across process restarts.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import type { DispatchPolicyCommand } from "./Base3PolicyGate.ts";

export function argumentHash(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const messageArguments = (command: DispatchPolicyCommand) => ({
  text: command.text ?? "",
  model: command.modelSelection?.model ?? null,
  instanceId: command.modelSelection?.instanceId ?? null,
  attachmentIds: (command.attachments ?? []).map((attachment) => attachment.id ?? ""),
  ...(command.modelSelection?.options === undefined
    ? {}
    : { options: command.modelSelection.options }),
  ...(command.modelRouteConstraints === undefined
    ? {}
    : { modelRouteConstraints: command.modelRouteConstraints }),
});
