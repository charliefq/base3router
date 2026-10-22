/** Adapter contract v1. Reconcile this transport boundary with the bridge before integration. */
export const CONTROLLER_CONTRACT_VERSION = 1 as const;
export const controllerActions = [
  "create_task",
  "start_task",
  "get_task",
  "get_result",
  "submit_feedback",
  "cancel_task",
] as const;
export type ControllerAction = (typeof controllerActions)[number];
export type ControllerKind = "grokbot" | "muse" | "dot";
export type TaskState = "created" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export interface ControllerTask {
  taskId: string;
  projectId: string;
  state: TaskState;
  supervisorId: string;
  runId: string | null;
}
export interface ControllerInputs {
  create_task: { projectId: string; title: string; prompt: string; idempotencyKey: string };
  start_task: { taskId: string; idempotencyKey: string };
  get_task: { taskId: string };
  get_result: { taskId: string };
  submit_feedback: { taskId: string; runId: string; feedback: string; idempotencyKey: string };
  cancel_task: { taskId: string; idempotencyKey: string };
}
export interface ControllerOutputs {
  create_task: { receiptId: string; task: ControllerTask };
  start_task: { receiptId: string; taskId: string; runId: string | null; started: boolean };
  get_task: { task: ControllerTask };
  get_result: { taskId: string; runId: string | null; terminal: boolean; result: string | null };
  submit_feedback: { receiptId: string; accepted: boolean };
  cancel_task: { receiptId: string; accepted: boolean };
}
export type ControllerRequest<A extends ControllerAction = ControllerAction> = {
  version: typeof CONTROLLER_CONTRACT_VERSION;
  action: A;
  input: ControllerInputs[A];
};
/** The authenticated transport supplies caller identity; inputs cannot impersonate another caller. */
export interface ControllerTransport {
  callTool(request: ControllerRequest): Promise<unknown>;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function nullableText(value: unknown) {
  return value === null || text(value);
}
function task(value: unknown): value is ControllerTask {
  return (
    record(value) &&
    text(value.taskId) &&
    text(value.projectId) &&
    text(value.supervisorId) &&
    nullableText(value.runId) &&
    typeof value.state === "string" &&
    ["created", "running", "waiting", "completed", "failed", "cancelled"].includes(
      String(value.state),
    )
  );
}
function validOutput(action: ControllerAction, value: unknown): boolean {
  if (!record(value)) return false;
  switch (action) {
    case "create_task":
      return text(value.receiptId) && task(value.task);
    case "get_task":
      return task(value.task);
    case "start_task":
      return (
        text(value.receiptId) &&
        text(value.taskId) &&
        nullableText(value.runId) &&
        typeof value.started === "boolean" &&
        (!value.started || text(value.runId))
      );
    case "get_result":
      return (
        text(value.taskId) &&
        nullableText(value.runId) &&
        typeof value.terminal === "boolean" &&
        (value.result === null || typeof value.result === "string") &&
        (value.terminal || value.result === null)
      );
    case "submit_feedback":
    case "cancel_task":
      return text(value.receiptId) && typeof value.accepted === "boolean";
  }
}
export function createControllerClient(transport: ControllerTransport) {
  return {
    async call<A extends ControllerAction>(
      action: A,
      input: ControllerInputs[A],
    ): Promise<ControllerOutputs[A]> {
      const reply = await transport.callTool({
        version: CONTROLLER_CONTRACT_VERSION,
        action,
        input,
      });
      if (
        !record(reply) ||
        reply.version !== CONTROLLER_CONTRACT_VERSION ||
        reply.action !== action ||
        !validOutput(action, reply.output)
      ) {
        // Never include a raw transport reply: it may contain private task content or credentials.
        throw new Error("Controller bridge returned an incompatible v1 response.");
      }
      const output = reply.output as ControllerOutputs[A];
      if (
        ("taskId" in input && "taskId" in output && input.taskId !== output.taskId) ||
        ("taskId" in input && "task" in output && input.taskId !== output.task.taskId) ||
        ("projectId" in input && "task" in output && input.projectId !== output.task.projectId)
      ) {
        throw new Error("Controller bridge returned evidence for a different task or project.");
      }
      return output;
    },
  };
}
