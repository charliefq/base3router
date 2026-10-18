import { OrchestrationV2Command } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const Attempt = Schema.Struct({
  status: Schema.Literals(["pending", "unknown", "admitted", "rejected"]),
  command: OrchestrationV2Command,
});
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Attempt));
const encode = Schema.encodeSync(Schema.fromJsonString(Attempt));
export type FirstLaunchAttempt = {
  readonly status: "pending" | "unknown" | "admitted" | "rejected";
  readonly command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
};
export const firstLaunchStorageKey = (environmentId: string, threadId: string) =>
  `t3:task-first-launch:v1:${JSON.stringify([environmentId, threadId])}`;
export function readFirstLaunchAttempt(key: string): {
  attempt: FirstLaunchAttempt | null;
  error: string | null;
} {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { attempt: null, error: null };
    const value = decode(raw);
    if (
      value._tag === "Some" &&
      value.value.command.type === "message.dispatch" &&
      value.value.command.taskFirstLaunch
    ) {
      const c = value.value.command;
      const m = c.taskFirstLaunch!;
      if (
        firstLaunchStorageKey(m.reference.environmentId, c.threadId) === key &&
        m.commandId === c.commandId &&
        m.messageId === c.messageId &&
        m.threadId === c.threadId
      )
        return { attempt: { status: value.value.status, command: c }, error: null };
    }
    return {
      attempt: null,
      error:
        "Saved first-launch identity is unreadable. Launch is blocked; recover original storage before another start.",
    };
  } catch {
    return {
      attempt: null,
      error: "First-launch recovery storage is unavailable. No start can be sent safely.",
    };
  }
}
export function writeFirstLaunchAttempt(key: string, attempt: FirstLaunchAttempt) {
  const value = encode(attempt);
  sessionStorage.setItem(key, value);
  if (sessionStorage.getItem(key) !== value)
    throw new Error("Original launch identity was not retained");
}
export function clearRejectedFirstLaunchAttempt(key: string) {
  const saved = readFirstLaunchAttempt(key);
  if (saved.error || saved.attempt?.status !== "rejected")
    throw new Error("Unresolved launch cannot be replaced");
  sessionStorage.removeItem(key);
}
