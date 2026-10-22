import type {
  ControllerIdentityView,
  ControllerInput,
  ControllerTaskView,
  ControllerTool,
} from "../../packages/contracts/src/controllerBridge.ts";
import {
  ControllerClientError,
  createControllerClient,
  type ControllerTransport,
} from "../../packages/client-runtime/src/controllers/client.ts";

export type Product = "dot" | "muse";
type Identity = typeof ControllerIdentityView.Type;
type Mutation = Exclude<ControllerTool, "get_task" | "get_result">;
export type Checkpoint = {
  [A in Mutation]: {
    product: Product;
    controllerId: string;
    generation: number;
    action: A;
    input: ControllerInput<A>;
  };
}[Mutation];
export type Binding = { product: Product; identity: Identity };

export class SupervisorError extends Error {
  readonly code: "denied" | "pending" | "target_changed" | "not_reviewable";
  constructor(code: SupervisorError["code"]) {
    super(`Controller supervisor: ${code}.`);
    this.code = code;
  }
}

/** Product labels never select credentials or confer authority. Bind separate owner-selected IDs. */
export function bindProducts(dot: Identity, muse: Identity): readonly Binding[] {
  if (dot.id === muse.id) throw new SupervisorError("denied");
  return [
    { product: "dot", identity: dot },
    { product: "muse", identity: muse },
  ];
}

export function supervisionState(view: ControllerTaskView) {
  if (
    view.admission === "unknown" ||
    view.execution === "unknown" ||
    view.receipt?.status === "unknown"
  )
    return "unknown";
  if (view.terminal) return "review";
  if (view.execution === "observed") return "running";
  return "waiting";
}

/**
 * Host supplies authenticated transport and a private durable journal. Save must complete before
 * any write. No polling, retries, credential enrollment, grants, or provider requests happen here.
 */
export function createSupervisor(options: {
  binding: Binding;
  transport: ControllerTransport;
  now: () => number;
  savePending: (checkpoint: Checkpoint | null) => Promise<void>;
  restored?: Checkpoint;
}) {
  const binding: Binding = structuredClone(options.binding);
  const client = createControllerClient(options.transport, binding.identity.id);
  let pending = options.restored ? structuredClone(options.restored) : null;
  let busy = false;

  function permit(action: ControllerTool, projectId?: string) {
    const identity = binding.identity;
    const expiry = Date.parse(identity.expiresAt);
    if (
      identity.revokedAt !== null ||
      !Number.isFinite(expiry) ||
      expiry <= options.now() ||
      !identity.actions.includes(action) ||
      (projectId !== undefined && !identity.projects.includes(projectId))
    )
      throw new SupervisorError("denied");
  }

  async function read(action: "get_task" | "get_result", taskId: string) {
    permit(action);
    const view = await client.call(action, { taskId });
    permit(action, view.projectId);
    return view;
  }

  function sameTarget(
    view: ControllerTaskView,
    input: ControllerInput<Exclude<Mutation, "create_task">>,
  ) {
    if (view.fence !== input.expectedFence || view.contractRevision !== input.expectedRevision) {
      throw new SupervisorError("target_changed");
    }
    if (
      "runId" in input &&
      (view.run?.runId !== input.runId || view.run.attemptId !== input.attemptId)
    )
      throw new SupervisorError("target_changed");
  }

  function validateCheckpoint(checkpoint: Checkpoint) {
    if (
      checkpoint.product !== binding.product ||
      checkpoint.controllerId !== binding.identity.id ||
      checkpoint.generation !== binding.identity.generation
    )
      throw new SupervisorError("denied");
    // Shared client rejects extra fields and validates the authoritative contract before dispatch.
    return client.prepare(checkpoint.action, checkpoint.input);
  }

  async function dispatch(checkpoint: Checkpoint) {
    permit(
      checkpoint.action,
      checkpoint.action === "create_task" ? checkpoint.input.projectId : undefined,
    );
    const prepared = validateCheckpoint(checkpoint);
    // For recovery never replace the retained revision/fence/run/payload with a later read.
    let view: ControllerTaskView;
    try {
      view = await prepared.send();
    } catch (error) {
      // Definitive bridge rejection ends this operation. Unknown transport/response outcomes
      // remain journalled; a new key or changed request must never bypass them.
      if (
        error instanceof ControllerClientError &&
        ["unauthorized", "denied", "invalid_request", "stale", "conflict"].includes(error.code)
      ) {
        await options.savePending(null);
        pending = null;
      }
      throw error;
    }
    permit(checkpoint.action, view.projectId);
    if (supervisionState(view) !== "unknown") {
      await options.savePending(null);
      pending = null;
    }
    return view;
  }

  async function exclusive<T>(operation: () => Promise<T>) {
    if (busy) throw new SupervisorError("pending");
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  async function mutate<A extends Mutation>(action: A, input: ControllerInput<A>) {
    return exclusive(async () => {
      if (pending) throw new SupervisorError("pending");
      // Snapshot before awaiting a read or journal. Caller mutation cannot alter a reviewed request.
      const captured = structuredClone(input);
      client.prepare(action, captured);
      permit(action, "projectId" in captured ? captured.projectId : undefined);
      if ("taskId" in captured) {
        const current = await read("get_task", captured.taskId);
        permit(action, current.projectId);
        sameTarget(current, captured);
        if (
          action === "start_task" &&
          (current.run !== null || current.terminal || current.admission !== "created")
        ) {
          throw new SupervisorError("target_changed");
        }
        if (action === "cancel_task" && (current.terminal || current.run === null)) {
          throw new SupervisorError("target_changed");
        }
        if (action === "submit_feedback") {
          const feedback = captured as ControllerInput<"submit_feedback">;
          if (
            !current.terminal ||
            current.feedback?.status !== "available" ||
            current.feedback.fingerprint !== feedback.fingerprint ||
            current.feedback.contextKey !== feedback.contextKey
          ) {
            throw new SupervisorError("not_reviewable");
          }
        }
      }
      const checkpoint = {
        product: binding.product,
        controllerId: binding.identity.id,
        generation: binding.identity.generation,
        action,
        input: captured,
      } as Checkpoint;
      validateCheckpoint(checkpoint);
      await options.savePending(structuredClone(checkpoint));
      pending = checkpoint;
      return dispatch(checkpoint);
    });
  }

  return {
    readTask: (taskId: string) => read("get_task", taskId),
    readResult: (taskId: string) => read("get_result", taskId),
    mutate,
    checkpoint: () => (pending ? structuredClone(pending) : null),
    /** Only call following explicit recovery authorization; transport errors may have executed. */
    recover: () =>
      exclusive(async () => {
        if (!pending) throw new SupervisorError("pending");
        return dispatch(pending);
      }),
    /** New prompt = a new reviewed create_task, followed by a separate guarded start_task. */
    nextTask: async (
      review: {
        taskId: string;
        runId: string;
        attemptId: string;
        expectedFence: number;
        expectedRevision: number;
        rationale: string;
      },
      input: ControllerInput<"create_task">,
    ) => {
      const captured = structuredClone(input);
      const reviewed = structuredClone(review);
      if (!reviewed.rationale.trim()) throw new SupervisorError("not_reviewable");
      const previous = await read("get_task", reviewed.taskId);
      sameTarget(previous, { ...reviewed, idempotencyKey: "review-only" });
      if (
        !previous.terminal ||
        previous.result.status !== "available" ||
        previous.result.content.status === "unknown" ||
        previous.result.runId !== reviewed.runId ||
        previous.result.attemptId !== reviewed.attemptId ||
        supervisionState(previous) === "unknown"
      )
        throw new SupervisorError("not_reviewable");
      if (previous.projectId !== captured.projectId) throw new SupervisorError("denied");
      return mutate("create_task", captured);
    },
    /** Refresh owner metadata after grant changes; never broadens authority by editing a template. */
    updateIdentity: (identity: Identity) => {
      if (
        identity.id !== binding.identity.id ||
        identity.generation < binding.identity.generation
      ) {
        throw new SupervisorError("denied");
      }
      binding.identity = structuredClone(identity);
    },
  };
}
