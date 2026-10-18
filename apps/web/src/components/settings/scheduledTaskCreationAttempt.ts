import { EnvironmentId, ScheduledTaskUpsertInput, type ScheduledTask } from "@t3tools/contracts";
import { canonicalizeJson } from "@t3tools/shared/actionCanonical";
import * as Schema from "effect/Schema";

const KEY = "t3:scheduled-task-creation:v1";
const Attempt = Schema.Struct({ environmentId: EnvironmentId, input: ScheduledTaskUpsertInput });
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Attempt));
const encode = Schema.encodeSync(Schema.fromJsonString(Attempt));
export type ScheduledTaskCreationAttempt = typeof Attempt.Type;

export function readScheduledTaskCreationAttempt(): {
  attempt: ScheduledTaskCreationAttempt | null;
  error: string | null;
} {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored === null) return { attempt: null, error: null };
    const result = decode(stored);
    if (
      result._tag === "Some" &&
      result.value.input.commandId &&
      !result.value.input.id &&
      !result.value.input.requireExisting
    )
      return { attempt: result.value, error: null };
    return {
      attempt: null,
      error:
        "The original scheduled task creation identity could not be read. New creation is blocked.",
    };
  } catch {
    return {
      attempt: null,
      error: "Scheduled task recovery storage is unavailable. New creation is blocked.",
    };
  }
}

// One tab-local unresolved create, saved before any request. It is never replayed.
export function retainScheduledTaskCreationAttempt(attempt: ScheduledTaskCreationAttempt) {
  const current = readScheduledTaskCreationAttempt();
  if (current.error || current.attempt)
    throw new Error(current.error ?? "Recover the original scheduled task first.");
  const encoded = encode(attempt);
  const snapshot = decode(encoded);
  if (snapshot._tag !== "Some") throw new Error("Could not retain the submitted schedule.");
  sessionStorage.setItem(KEY, encoded);
  return snapshot.value;
}
export function clearScheduledTaskCreationAttempt(attempt: ScheduledTaskCreationAttempt) {
  const current = readScheduledTaskCreationAttempt();
  if (current.error || canonicalizeJson(current.attempt) !== canonicalizeJson(attempt))
    throw new Error("The scheduled task recovery identity changed. No recovery state was cleared.");
  sessionStorage.removeItem(KEY);
}
export function matchesScheduledTaskCreation(
  attempt: ScheduledTaskCreationAttempt,
  task: ScheduledTask,
) {
  const input = attempt.input;
  if (task.id !== `scheduled-task:${input.commandId}`) return false;
  // Compare submitted fields only: occurrence/timing history may advance independently.
  const fields = (value: ScheduledTaskUpsertInput | ScheduledTask) => ({
    title: value.title,
    prompt: value.prompt,
    enabled: value.enabled,
    schedule: value.schedule,
    projectId: value.projectId,
    threadId: value.threadId ?? null,
    workspaceStrategy: value.workspaceStrategy,
    modelSelection: value.modelSelection,
    runtimeMode: value.runtimeMode,
    interactionMode: value.interactionMode,
    createdBy: value.createdBy ?? "user",
    creationSource: value.creationSource ?? "web",
  });
  return canonicalizeJson(fields(input)) === canonicalizeJson(fields(task));
}
