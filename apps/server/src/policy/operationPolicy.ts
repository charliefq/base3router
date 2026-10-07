/**
 * Which Base3 policy applies to a V2 command.
 * Ordinary model turns are not external-write approvals.
 * Anything not listed fails closed for authenticated sessions.
 */

const READ_COMMANDS = new Set(["thread.visit"]);

const AUTH_ONLY_COMMANDS = new Set([
  "thread.create",
  "thread.auto-settle",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.auto-settle.set",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.active.reorder",
  "thread.mark-unread",
  "thread.metadata.update",
  "thread.pull-request.link",
  "thread.pull-request.unlink",
  "thread.pull-request-link.sync",
  "thread.pull-request.sync",
  "thread.title.regeneration.complete",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.model-selection.set",
  "provider-session.detach",
  "notification.delivery.accept",
  "prepared-run.progress",
  "prepared-run.fail",
  "runtime-request.respond",
  "thread.user-input.dismiss",
  "queued-run.reorder",
  "queued-run.cancel",
  "checkpoint.rollback.fail",
  "thread.background-work.settle",
  "thread.fork",
  "thread.merge_back",
  "delegated_task.wake-policy",
  "delegated_task.completion-delivery.acknowledge",
  "delegated_task.completion-delivery.dispose",
  "thread.created.record",
]);

export type OperationClass =
  | { readonly kind: "read" }
  | { readonly kind: "auth-only" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "provider-switch" }
  | { readonly kind: "message"; readonly continuation: boolean; readonly ask: false }
  | { readonly kind: "delegation" }
  | { readonly kind: "queue-resume" }
  | { readonly kind: "queue-edit" }
  | { readonly kind: "steer" }
  | { readonly kind: "release" }
  | { readonly kind: "rollback" }
  | { readonly kind: "ungoverned" };

export function classifyCommand(type: string): OperationClass {
  if (READ_COMMANDS.has(type)) return { kind: "read" };
  if (AUTH_ONLY_COMMANDS.has(type)) return { kind: "auth-only" };
  switch (type) {
    case "run.interrupt":
      return { kind: "interrupt" };
    case "provider.switch":
      return { kind: "provider-switch" };
    case "message.dispatch":
      return { kind: "message", continuation: false, ask: false };
    case "delegated_task.request":
      return { kind: "delegation" };
    case "queue.resume":
      return { kind: "queue-resume" };
    case "queued-run.edit":
      return { kind: "queue-edit" };
    case "queued-message.promote-to-steer":
      return { kind: "steer" };
    case "prepared-run.release":
      return { kind: "release" };
    case "checkpoint.rollback":
      return { kind: "rollback" };
    default:
      return { kind: "ungoverned" };
  }
}

export function commandNeedsCapacity(operation: OperationClass): boolean {
  return (
    operation.kind === "message" ||
    operation.kind === "delegation" ||
    operation.kind === "release" ||
    operation.kind === "steer"
  );
}
