import { OrchestrationV2Command } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const STORAGE_KEY = "t3:agents-governed-creation:v1";
const Attempt = Schema.Struct({
  status: Schema.Literals(["pending", "uncertain", "confirmed"]),
  command: OrchestrationV2Command,
});
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Attempt));
const encode = Schema.encodeSync(Schema.fromJsonString(Attempt));
export type AgentsCreationAttempt = {
  readonly status: "pending" | "uncertain" | "confirmed";
  readonly command: Extract<OrchestrationV2Command, { type: "thread.create" }>;
};
export function readAgentsCreationAttempt(): {
  attempt: AgentsCreationAttempt | null;
  error: string | null;
} {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored === null) return { attempt: null, error: null };
    const decoded = decode(stored);
    if (
      decoded._tag !== "Some" ||
      decoded.value.command.type !== "thread.create" ||
      !decoded.value.command.taskCreationReview ||
      decoded.value.command.taskGovernance !== "required" ||
      !decoded.value.command.taskContract
    )
      return {
        attempt: null,
        error:
          "A saved creation attempt could not be read. Creation is blocked until its original identity can be recovered.",
      };
    return {
      attempt: { status: decoded.value.status, command: decoded.value.command },
      error: null,
    };
  } catch {
    return {
      attempt: null,
      error: "Creation recovery storage is unavailable. No task creation can be sent safely.",
    };
  }
}
export function writeAgentsCreationAttempt(attempt: AgentsCreationAttempt): void {
  sessionStorage.setItem(STORAGE_KEY, encode(attempt));
}
