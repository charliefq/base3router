/**
 * Fold for internal provider identities and external contractors.
 *
 * A sealed command already names the authenticated principal in `admittedBy`.
 * Client `actor` and `fromAgentId` are ignored. A gate other than ALLOW
 * records a blocked task and does not dispatch work. Real Grokbot stays
 * NOT_CONNECTED.
 */
import {
  GROKBOT_INTEGRATION_REQUIREMENTS,
  type CollaborationAgent,
  type CollaborationCommand,
  type CollaborationCommandResult,
  type CollaborationGateDecision,
  type CollaborationMessage,
  type CollaborationRejection,
  type CollaborationSnapshot,
  type CollaborationTask,
} from "@t3tools/contracts";

interface StoredAgent {
  readonly id: string;
  readonly displayName: string;
  readonly origin: CollaborationAgent["origin"];
  readonly role: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly connection: CollaborationAgent["connection"];
  readonly projectId: string | null;
  readonly threadId: string | null;
}

interface StoredState {
  readonly agents: ReadonlyArray<StoredAgent>;
  readonly tasks: ReadonlyArray<CollaborationTask>;
  readonly messages: ReadonlyArray<CollaborationMessage>;
  readonly appliedCommandIds: ReadonlyArray<string>;
}

const grokbotAgent: StoredAgent = {
  id: "grokbot",
  displayName: "Grokbot",
  origin: "external",
  role: "contractor",
  capabilities: ["delegate", "converse"],
  connection: "NOT_CONNECTED",
  projectId: null,
  threadId: null,
};

export const initialCollaboration = (): StoredState => ({
  agents: [grokbotAgent],
  tasks: [],
  messages: [],
  appliedCommandIds: [],
});

const availabilityFor = (
  agent: StoredAgent,
  tasks: ReadonlyArray<CollaborationTask>,
): CollaborationAgent["availability"] => {
  if (agent.origin === "external" && agent.connection === "NOT_CONNECTED") return "offline";
  const open = tasks.filter(
    (task) => task.assigneeAgentId === agent.id && task.state !== "completed",
  );
  if (open.some((task) => task.state === "running")) return "working";
  if (open.some((task) => task.state === "blocked" || task.state === "review-ready")) {
    return "waiting";
  }
  return "unknown";
};

export const projectCollaboration = (state: StoredState): CollaborationSnapshot => ({
  agents: state.agents.map((agent) => ({
    ...agent,
    capabilities: [...agent.capabilities],
    availability: availabilityFor(agent, state.tasks),
    threadId: agent.threadId,
  })),
  tasks: state.tasks.map((task) => ({ ...task })),
  messages: state.messages.map((message) => ({ ...message })),
  realGrokbot: "NOT_CONNECTED",
  grokbotIntegration: [...GROKBOT_INTEGRATION_REQUIREMENTS],
});

const rejected = (
  state: StoredState,
  code: CollaborationRejection,
  detail: string,
  gateDecision: CollaborationGateDecision | null = "DENY",
): CollaborationCommandResult => ({
  outcome: "rejected",
  code,
  detail,
  idempotent: false,
  gateDecision,
  snapshot: projectCollaboration(state),
});

const applied = (
  state: StoredState,
  detail: string,
  idempotent: boolean,
  gateDecision: CollaborationGateDecision | null,
): CollaborationCommandResult => ({
  outcome: "applied",
  code: null,
  detail,
  idempotent,
  gateDecision,
  snapshot: projectCollaboration(state),
});

const remember = (
  state: StoredState,
  commandId: string,
  next: Partial<StoredState>,
): StoredState => ({
  agents: next.agents ?? state.agents,
  tasks: next.tasks ?? state.tasks,
  messages: next.messages ?? state.messages,
  appliedCommandIds: state.appliedCommandIds.includes(commandId)
    ? state.appliedCommandIds
    : [...state.appliedCommandIds, commandId],
});

const findAgent = (state: StoredState, agentId: string) =>
  state.agents.find((agent) => agent.id === agentId);

const externalDisconnected = (agent: StoredAgent) =>
  agent.origin === "external" && agent.connection === "NOT_CONNECTED";

const notReady = (state: StoredState, detail: string) => rejected(state, "not-ready", detail, null);

const sealedPrincipal = (command: CollaborationCommand) =>
  command.admissionSource === "server" && command.admittedBy ? command.admittedBy : null;

const transportOf = (
  state: StoredState,
  senderId: string,
  recipientId: string,
): CollaborationMessage["transport"] => {
  const parties = [findAgent(state, senderId), findAgent(state, recipientId)];
  return parties.some((agent) => agent?.connection === "SIMULATED") ? "simulated" : "internal";
};

const message = (
  state: StoredState,
  input: Omit<CollaborationMessage, "revision" | "grantsExecution" | "transport">,
): CollaborationMessage => ({
  ...input,
  revision: state.messages.filter((item) => item.taskId === input.taskId).length + 1,
  grantsExecution: false,
  transport: transportOf(state, input.senderId, input.recipientId),
});

const replaceTask = (state: StoredState, task: CollaborationTask) =>
  state.tasks.map((item) => (item.id === task.id ? task : item));

const taskById = (state: StoredState, taskId: string | undefined) =>
  taskId ? state.tasks.find((task) => task.id === taskId) : undefined;

const admitParties = (state: StoredState, to: StoredAgent, projectId: string) => {
  if (to.projectId !== null && to.projectId !== projectId) {
    return rejected(state, "cross-project", "The recipient belongs to a different project.");
  }
  if (externalDisconnected(to)) {
    return rejected(
      state,
      "not-connected",
      "The external agent is NOT_CONNECTED. A simulated transport is not a live Grokbot connection.",
    );
  }
  return null;
};

const applyOne = (
  state: StoredState,
  command: CollaborationCommand,
): CollaborationCommandResult => {
  if (state.appliedCommandIds.includes(command.commandId)) {
    return applied(state, "This command was already applied.", true, null);
  }
  const principalId = sealedPrincipal(command);
  if (!principalId) {
    return rejected(state, "unauthorized", "Client actor and fromAgentId do not grant authority.");
  }

  switch (command.type) {
    case "agent.register":
    case "transport.simulate":
    case "scenario.rehearse":
      return rejected(
        state,
        "unauthorized",
        "The product API does not persist a simulated rehearsal or a client-registered employee.",
      );
    case "thread.bind":
      return bindThread(state, command, principalId);
    case "delegate":
      return delegateTo(state, command, principalId);
    case "resolve":
      return resolveName(state, command, principalId);
    case "clarify":
      return clarify(state, command, principalId);
    case "reply":
      return reply(state, command, principalId);
    case "result":
      return result(state, command, principalId);
    case "accept":
      return accept(state, command, principalId);
  }
};

const bindThread = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  const { agentId, displayName, projectId, threadId, capabilities } = command;
  if (
    !agentId ||
    !displayName ||
    !projectId ||
    !threadId ||
    !capabilities ||
    command.origin !== "internal"
  ) {
    return notReady(state, "A thread bind names an internal provider, a project, and a thread.");
  }
  if (agentId === "grokbot") {
    return rejected(
      state,
      "not-connected",
      "Grokbot is NOT_CONNECTED. No thread was opened for it.",
    );
  }
  const current = findAgent(state, agentId);
  if (
    current &&
    (current.displayName !== displayName ||
      current.origin !== "internal" ||
      current.projectId !== projectId ||
      current.threadId !== threadId)
  ) {
    return rejected(state, "identity-conflict", "That agent id already names someone else.");
  }
  const agent: StoredAgent = {
    id: agentId,
    displayName,
    origin: "internal",
    role: command.role ?? "provider",
    capabilities,
    connection: "NOT_CONNECTED",
    projectId,
    threadId,
  };
  const agents = current
    ? state.agents.map((item) => (item.id === agent.id ? agent : item))
    : [...state.agents, agent];
  const correlationId = `thread:${threadId}`;
  const existing = state.tasks.find((task) => task.correlationId === correlationId);
  if (existing) {
    return applied(
      remember(state, command.commandId, { agents }),
      "That thread is already linked.",
      true,
      existing.gateDecision,
    );
  }
  const task: CollaborationTask = {
    id: `task:${correlationId}`,
    title: command.title ?? displayName,
    ownerAgentId: principalId,
    assigneeAgentId: agent.id,
    projectId,
    state: "blocked",
    waitReason: "Execution is blocked. Opening a thread does not start a provider turn.",
    acceptance: "The conversation stays on this thread.",
    threadId,
    correlationId,
    revision: 1,
    pendingClarificationId: null,
    gateDecision: "DENY",
  };
  return applied(
    remember(state, command.commandId, { agents, tasks: [...state.tasks, task] }),
    "The provider thread is linked. The link does not grant execution.",
    false,
    "DENY",
  );
};

const delegateTo = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  const { correlationId, projectId, toAgentId, title, body, acceptance, gateDecision } = command;
  if (
    !correlationId ||
    !projectId ||
    !toAgentId ||
    !title ||
    !body ||
    !acceptance ||
    !gateDecision
  ) {
    return notReady(state, "Delegation needs a project, one target, and a gate decision.");
  }
  const to = findAgent(state, toAgentId);
  if (!to) return rejected(state, "unknown-agent", "The target agent is not registered.");
  const blocked = admitParties(state, to, projectId);
  if (blocked) return blocked;
  const existing = state.tasks.find((task) => task.correlationId === correlationId);
  if (existing) {
    return applied(
      remember(state, command.commandId, {}),
      "That correlation already has one task.",
      true,
      existing.gateDecision,
    );
  }
  const allowed = gateDecision === "ALLOW";
  const taskId = `task:${correlationId}`;
  const task: CollaborationTask = {
    id: taskId,
    title,
    ownerAgentId: principalId,
    assigneeAgentId: to.id,
    projectId,
    state: allowed ? "running" : "blocked",
    waitReason: allowed ? null : "ActionGate did not allow execution.",
    acceptance,
    threadId: to.threadId,
    correlationId,
    revision: 1,
    pendingClarificationId: null,
    gateDecision,
  };
  const delegation = message(
    { ...state, agents: state.agents },
    {
      id: `${taskId}:delegation:${command.commandId}`,
      taskId,
      senderId: principalId,
      recipientId: to.id,
      replyTo: null,
      kind: "delegation",
      body,
      correlationId,
    },
  );
  return applied(
    remember(state, command.commandId, {
      tasks: [...state.tasks, task],
      messages: [...state.messages, delegation],
    }),
    allowed
      ? "The gate allowed the task. The message still does not grant execution."
      : "The gate refused execution. The task is blocked.",
    false,
    gateDecision,
  );
};

const resolveName = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  if (!command.name) return notReady(state, "Name resolution needs one exact name.");
  const matches = state.agents.filter((agent) => agent.displayName === command.name);
  if (matches.length > 1) {
    return rejected(state, "ambiguous-target", "That name matches more than one agent.");
  }
  const to = matches[0];
  if (!to) return rejected(state, "unknown-agent", "That name does not match an agent.");
  return delegateTo(state, { ...command, toAgentId: to.id }, principalId);
};

const clarify = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  if (!command.taskId || !command.body) {
    return notReady(state, "Clarification names the task and the question.");
  }
  const task = taskById(state, command.taskId);
  if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
  if (task.assigneeAgentId !== principalId) {
    return rejected(state, "unauthorized", "Only the assignee can ask for clarification.");
  }
  if (task.state !== "running" || task.pendingClarificationId) {
    return rejected(
      state,
      "not-ready",
      "Clarification waits for a running task with no open question.",
      null,
    );
  }
  const note = message(state, {
    id: `${task.id}:clarify:${command.commandId}`,
    taskId: task.id,
    senderId: principalId,
    recipientId: task.ownerAgentId,
    replyTo: state.messages.find((item) => item.taskId === task.id)?.id ?? null,
    kind: "clarification",
    body: command.body,
    correlationId: task.correlationId,
  });
  const nextTask: CollaborationTask = {
    ...task,
    state: "blocked",
    waitReason: command.body,
    revision: task.revision + 1,
    pendingClarificationId: note.id,
  };
  return applied(
    remember(state, command.commandId, {
      tasks: replaceTask(state, nextTask),
      messages: [...state.messages, note],
    }),
    "The assignee is waiting on the current question.",
    false,
    null,
  );
};

const reply = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  if (!command.taskId || !command.body || !command.replyTo || command.revision === undefined) {
    return notReady(state, "A reply cites the current clarification and its revision.");
  }
  const task = taskById(state, command.taskId);
  if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
  if (task.ownerAgentId !== principalId) {
    return rejected(state, "unauthorized", "Only the task owner can answer.");
  }
  if (task.state !== "blocked" || !task.pendingClarificationId) {
    return rejected(state, "not-ready", "There is no open clarification.", null);
  }
  if (command.replyTo !== task.pendingClarificationId) {
    return rejected(state, "not-ready", "The reply does not cite the current clarification.", null);
  }
  if (command.revision !== task.revision) {
    return rejected(state, "not-ready", "The reply cites an older revision.", null);
  }
  const target = state.messages.find((item) => item.id === command.replyTo);
  if (
    !target ||
    target.taskId !== task.id ||
    target.kind !== "clarification" ||
    target.recipientId !== task.ownerAgentId ||
    target.senderId !== task.assigneeAgentId
  ) {
    return rejected(
      state,
      "not-ready",
      "The current clarification does not match this reply.",
      null,
    );
  }
  const nextTask: CollaborationTask = {
    ...task,
    state: "running",
    waitReason: null,
    revision: task.revision + 1,
    pendingClarificationId: null,
  };
  const note = message(state, {
    id: `${task.id}:reply:${command.commandId}`,
    taskId: task.id,
    senderId: principalId,
    recipientId: task.assigneeAgentId,
    replyTo: command.replyTo,
    kind: "reply",
    body: command.body,
    correlationId: task.correlationId,
  });
  return applied(
    remember(state, command.commandId, {
      tasks: replaceTask(state, nextTask),
      messages: [...state.messages, note],
    }),
    "The reply answered the current question.",
    false,
    null,
  );
};

const result = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  if (!command.taskId || !command.body) {
    return notReady(state, "A result names the task and the outcome.");
  }
  const task = taskById(state, command.taskId);
  if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
  if (task.assigneeAgentId !== principalId) {
    return rejected(state, "unauthorized", "Only the assignee can return a result.");
  }
  if (task.state !== "running" || task.pendingClarificationId) {
    return rejected(
      state,
      "not-ready",
      "A result follows a running task with no open question.",
      null,
    );
  }
  const nextTask: CollaborationTask = {
    ...task,
    state: "review-ready",
    waitReason: "Waiting for owner acceptance.",
    revision: task.revision + 1,
  };
  const note = message(state, {
    id: `${task.id}:result:${command.commandId}`,
    taskId: task.id,
    senderId: principalId,
    recipientId: task.ownerAgentId,
    replyTo: null,
    kind: "result",
    body: command.body,
    correlationId: task.correlationId,
  });
  return applied(
    remember(state, command.commandId, {
      tasks: replaceTask(state, nextTask),
      messages: [...state.messages, note],
    }),
    "The result returned to the originating task.",
    false,
    task.gateDecision,
  );
};

const accept = (
  state: StoredState,
  command: CollaborationCommand,
  principalId: string,
): CollaborationCommandResult => {
  if (!command.taskId || !command.acceptance) {
    return notReady(state, "Acceptance names the task and the accepted outcome.");
  }
  const task = taskById(state, command.taskId);
  if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
  if (task.ownerAgentId !== principalId) {
    return rejected(state, "unauthorized", "Only the task owner can accept a result.");
  }
  if (task.state !== "review-ready") {
    return rejected(state, "not-ready", "Acceptance waits for a returned result.", null);
  }
  const nextTask: CollaborationTask = {
    ...task,
    state: "completed",
    waitReason: null,
    acceptance: command.acceptance,
    revision: task.revision + 1,
  };
  return applied(
    remember(state, command.commandId, { tasks: replaceTask(state, nextTask) }),
    "The owner accepted the result.",
    false,
    task.gateDecision,
  );
};

const stateFromSnapshot = (
  previous: StoredState,
  commandId: string,
  snapshot: CollaborationSnapshot,
): StoredState => ({
  agents: snapshot.agents.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    origin: agent.origin,
    role: agent.role,
    capabilities: [...agent.capabilities],
    connection: agent.connection,
    projectId: agent.projectId,
    threadId: agent.threadId,
  })),
  tasks: snapshot.tasks.map((task) => ({ ...task })),
  messages: snapshot.messages.map((message) => ({ ...message })),
  appliedCommandIds: previous.appliedCommandIds.includes(commandId)
    ? previous.appliedCommandIds
    : [...previous.appliedCommandIds, commandId],
});

export const foldCollaborationState = (
  commands: ReadonlyArray<CollaborationCommand>,
): StoredState => {
  let state = initialCollaboration();
  for (const command of commands) {
    const result = applyOne(state, command);
    if (result.outcome !== "applied") continue;
    state = stateFromSnapshot(state, command.commandId, result.snapshot);
  }
  return state;
};

export const applyCollaboration = (
  state: StoredState,
  command: CollaborationCommand,
): CollaborationCommandResult => applyOne(state, command);

export const foldCollaboration = (
  commands: ReadonlyArray<CollaborationCommand>,
): CollaborationSnapshot => projectCollaboration(foldCollaborationState(commands));

export type { StoredState };
