/**
 * One coordination record for internal employees and external contractors.
 *
 * The gate admits or refuses the record. It does not start a provider and it
 * does not treat a model CLI as an employee. Simulated transport is labeled
 * on every message it carries. Real Grokbot stays NOT_CONNECTED.
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
    threadId: null,
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

interface AgentIdentity {
  readonly displayName: string;
  readonly origin: StoredAgent["origin"];
  readonly role: string;
  readonly projectId: string;
}

const sameIdentity = (current: StoredAgent, identity: AgentIdentity) =>
  current.displayName === identity.displayName &&
  current.origin === identity.origin &&
  current.role === identity.role &&
  current.projectId === identity.projectId;

const notReady = (state: StoredState, detail: string) => rejected(state, "not-ready", detail, null);

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

const admitParties = (
  state: StoredState,
  from: StoredAgent,
  to: StoredAgent,
  projectId: string,
) => {
  if (from.projectId !== null && from.projectId !== projectId) {
    return rejected(state, "cross-project", "The sender belongs to a different project.");
  }
  if (to.projectId !== null && to.projectId !== projectId) {
    return rejected(state, "cross-project", "The recipient belongs to a different project.");
  }
  if (externalDisconnected(from) || externalDisconnected(to)) {
    return rejected(
      state,
      "not-connected",
      "The external agent is NOT_CONNECTED. A simulated transport is not a live Grokbot connection.",
    );
  }
  return null;
};

interface DelegateFields {
  readonly commandId: string;
  readonly correlationId: string;
  readonly projectId: string;
  readonly fromAgentId: string;
  readonly title: string;
  readonly body: string;
  readonly acceptance: string;
}

const delegateTo = (
  state: StoredState,
  command: DelegateFields,
  to: StoredAgent,
): CollaborationCommandResult => {
  const from = findAgent(state, command.fromAgentId);
  if (!from) return rejected(state, "unknown-agent", "The sending agent is not registered.");
  const blocked = admitParties(state, from, to, command.projectId);
  if (blocked) return blocked;
  const existing = state.tasks.find((task) => task.correlationId === command.correlationId);
  if (existing) {
    return applied(
      remember(state, command.commandId, {}),
      "That correlation already has one task.",
      true,
      existing.gateDecision,
    );
  }
  const taskId = `task:${command.correlationId}`;
  const task: CollaborationTask = {
    id: taskId,
    title: command.title,
    ownerAgentId: from.id,
    assigneeAgentId: to.id,
    projectId: command.projectId,
    state: "running",
    waitReason: null,
    acceptance: command.acceptance,
    threadId: null,
    correlationId: command.correlationId,
    revision: 1,
    gateDecision: "ALLOW",
  };
  const delegation = message(state, {
    id: `${taskId}:delegation`,
    taskId,
    senderId: from.id,
    recipientId: to.id,
    replyTo: null,
    kind: "delegation",
    body: command.body,
    correlationId: command.correlationId,
  });
  return applied(
    remember(state, command.commandId, {
      tasks: [...state.tasks, task],
      messages: [...state.messages, delegation],
    }),
    "Delegation recorded. The message does not grant execution.",
    false,
    "ALLOW",
  );
};

const applyOne = (
  state: StoredState,
  command: CollaborationCommand,
): CollaborationCommandResult => {
  if (state.appliedCommandIds.includes(command.commandId)) {
    return applied(state, "This command was already applied.", true, null);
  }
  switch (command.type) {
    case "agent.register": {
      const { agentId, displayName, origin, role, capabilities, projectId } = command;
      if (!agentId || !displayName || !origin || !role || !capabilities || !projectId) {
        return notReady(
          state,
          "Registration needs an id, name, origin, role, capabilities, and project.",
        );
      }
      const current = findAgent(state, agentId);
      if (current) {
        if (!sameIdentity(current, { displayName, origin, role, projectId })) {
          return rejected(state, "identity-conflict", "That agent id already names someone else.");
        }
        return applied(
          remember(state, command.commandId, {}),
          "Agent already registered.",
          true,
          null,
        );
      }
      const agent: StoredAgent = {
        id: agentId,
        displayName,
        origin,
        role,
        capabilities,
        connection: "NOT_CONNECTED",
        projectId,
      };
      return applied(
        remember(state, command.commandId, { agents: [...state.agents, agent] }),
        "Agent registered. Availability stays unknown until work exists.",
        false,
        null,
      );
    }
    case "transport.simulate": {
      if (!command.agentId) return notReady(state, "Simulation names an agent.");
      const agent = findAgent(state, command.agentId);
      if (!agent) return rejected(state, "unknown-agent", "That agent is not registered.");
      const agents = state.agents.map((item) =>
        item.id === agent.id ? { ...item, connection: "SIMULATED" as const } : item,
      );
      return applied(
        remember(state, command.commandId, { agents }),
        "Simulated transport only. Real Grokbot remains NOT_CONNECTED.",
        false,
        null,
      );
    }
    case "delegate": {
      if (command.actor !== "owner") {
        return rejected(state, "unauthorized", "Only the owner can admit a delegation.");
      }
      const { correlationId, projectId, fromAgentId, toAgentId, title, body, acceptance } = command;
      if (
        !correlationId ||
        !projectId ||
        !fromAgentId ||
        !toAgentId ||
        !title ||
        !body ||
        !acceptance
      ) {
        return notReady(state, "Delegation needs parties, a project, a title, and a body.");
      }
      const to = findAgent(state, toAgentId);
      if (!to) return rejected(state, "unknown-agent", "The target agent is not registered.");
      return delegateTo(
        state,
        {
          commandId: command.commandId,
          correlationId,
          projectId,
          fromAgentId,
          title,
          body,
          acceptance,
        },
        to,
      );
    }
    case "resolve": {
      if (command.actor !== "owner") {
        return rejected(state, "unauthorized", "Only the owner can admit a delegation.");
      }
      const { name, correlationId, projectId, fromAgentId, title, body, acceptance } = command;
      if (!name || !correlationId || !projectId || !fromAgentId || !title || !body || !acceptance) {
        return notReady(state, "Name resolution needs one exact name and a complete delegation.");
      }
      const matches = state.agents.filter((agent) => agent.displayName === name);
      if (matches.length > 1) {
        return rejected(state, "ambiguous-target", "That name matches more than one agent.");
      }
      const to = matches[0];
      if (!to) return rejected(state, "unknown-agent", "That name does not match an agent.");
      return delegateTo(
        state,
        {
          commandId: command.commandId,
          correlationId,
          projectId,
          fromAgentId,
          title,
          body,
          acceptance,
        },
        to,
      );
    }
    case "clarify": {
      const { taskId, fromAgentId, body } = command;
      if (!taskId || !fromAgentId || !body) {
        return notReady(state, "Clarification names the task, the assignee, and the question.");
      }
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
      if (task.assigneeAgentId !== fromAgentId) {
        return rejected(state, "unauthorized", "Only the assignee can ask for clarification.");
      }
      if (task.state !== "running") {
        return rejected(state, "not-ready", "Clarification waits for a running task.", null);
      }
      const nextTask: CollaborationTask = {
        ...task,
        state: "blocked",
        waitReason: body,
        revision: task.revision + 1,
      };
      const note = message(state, {
        id: `${task.id}:clarify`,
        taskId: task.id,
        senderId: fromAgentId,
        recipientId: task.ownerAgentId,
        replyTo: state.messages.find((item) => item.taskId === task.id)?.id ?? null,
        kind: "clarification",
        body,
        correlationId: task.correlationId,
      });
      return applied(
        remember(state, command.commandId, {
          tasks: replaceTask(state, nextTask),
          messages: [...state.messages, note],
        }),
        "The assignee is waiting on a reply.",
        false,
        null,
      );
    }
    case "reply": {
      const { taskId, fromAgentId, body, replyTo } = command;
      if (!taskId || !fromAgentId || !body || !replyTo) {
        return notReady(state, "A reply cites the task, the owner, and one message.");
      }
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
      if (task.ownerAgentId !== fromAgentId) {
        return rejected(state, "unauthorized", "Only the task owner can answer.");
      }
      if (task.state !== "blocked") {
        return rejected(state, "not-ready", "There is no open clarification.", null);
      }
      const target = state.messages.find((item) => item.id === replyTo);
      if (!target || target.taskId !== task.id) {
        return rejected(
          state,
          "not-ready",
          "The reply does not cite a message on this task.",
          null,
        );
      }
      const nextTask: CollaborationTask = {
        ...task,
        state: "running",
        waitReason: null,
        revision: task.revision + 1,
      };
      const note = message(state, {
        id: `${task.id}:reply:${task.revision + 1}`,
        taskId: task.id,
        senderId: fromAgentId,
        recipientId: task.assigneeAgentId,
        replyTo,
        kind: "reply",
        body,
        correlationId: task.correlationId,
      });
      return applied(
        remember(state, command.commandId, {
          tasks: replaceTask(state, nextTask),
          messages: [...state.messages, note],
        }),
        "The reply is on the original task.",
        false,
        null,
      );
    }
    case "result": {
      const { taskId, fromAgentId, body } = command;
      if (!taskId || !fromAgentId || !body) {
        return notReady(state, "A result names the task, the assignee, and the outcome.");
      }
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
      if (task.assigneeAgentId !== fromAgentId) {
        return rejected(state, "unauthorized", "Only the assignee can return a result.");
      }
      if (task.state !== "running") {
        return rejected(state, "not-ready", "A result follows a running task.", null);
      }
      const nextTask: CollaborationTask = {
        ...task,
        state: "review-ready",
        waitReason: "Waiting for owner acceptance.",
        revision: task.revision + 1,
      };
      const note = message(state, {
        id: `${task.id}:result:${task.revision + 1}`,
        taskId: task.id,
        senderId: fromAgentId,
        recipientId: task.ownerAgentId,
        replyTo: null,
        kind: "result",
        body,
        correlationId: task.correlationId,
      });
      return applied(
        remember(state, command.commandId, {
          tasks: replaceTask(state, nextTask),
          messages: [...state.messages, note],
        }),
        "The result returned to the originating task.",
        false,
        null,
      );
    }
    case "accept": {
      if (command.actor !== "owner") {
        return rejected(state, "unauthorized", "Only the owner can accept a result.");
      }
      if (!command.taskId || !command.acceptance) {
        return notReady(state, "Acceptance names the task and the accepted outcome.");
      }
      const task = state.tasks.find((item) => item.id === command.taskId);
      if (!task) return rejected(state, "unknown-agent", "That task does not exist.", null);
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
        "ALLOW",
      );
    }
    case "scenario.rehearse": {
      if (!command.scenario || !command.projectId) {
        return notReady(state, "A rehearsal names scenario A or B and one project.");
      }
      return rehearse(state, command.commandId, command.scenario, command.projectId);
    }
  }
};

const child = (
  commandId: string,
  scenario: "A" | "B",
  step: string,
  command: Omit<CollaborationCommand, "commandId">,
): CollaborationCommand =>
  ({ ...command, commandId: `${commandId}:${scenario}:${step}` }) as CollaborationCommand;

const rehearse = (
  state: StoredState,
  commandId: string,
  scenario: "A" | "B",
  projectId: string,
): CollaborationCommandResult => {
  if (state.appliedCommandIds.includes(commandId)) {
    return applied(state, "This rehearsal was already applied.", true, null);
  }
  const steps: CollaborationCommand[] =
    scenario === "A"
      ? [
          child(commandId, "A", "register", {
            type: "agent.register",
            agentId: "b3r-engineering",
            displayName: "B3R engineering",
            origin: "internal",
            role: "engineering",
            capabilities: ["build"],
            projectId,
          }),
          child(commandId, "A", "simulate", { type: "transport.simulate", agentId: "grokbot" }),
          child(commandId, "A", "delegate", {
            type: "delegate",
            correlationId: `scenario-a:${projectId}:build-x`,
            projectId,
            fromAgentId: "grokbot",
            toAgentId: "b3r-engineering",
            title: "Build X",
            body: "Ask B3R's engineering agent to build X.",
            acceptance: "X is built and the result is back with Grokbot.",
            actor: "owner",
          }),
          child(commandId, "A", "clarify", {
            type: "clarify",
            taskId: `task:scenario-a:${projectId}:build-x`,
            fromAgentId: "b3r-engineering",
            body: "Which X should be built?",
          }),
          child(commandId, "A", "reply", {
            type: "reply",
            taskId: `task:scenario-a:${projectId}:build-x`,
            fromAgentId: "grokbot",
            replyTo: `task:scenario-a:${projectId}:build-x:clarify`,
            body: "The X named in the task.",
          }),
          child(commandId, "A", "result", {
            type: "result",
            taskId: `task:scenario-a:${projectId}:build-x`,
            fromAgentId: "b3r-engineering",
            body: "X is built.",
          }),
          child(commandId, "A", "accept", {
            type: "accept",
            taskId: `task:scenario-a:${projectId}:build-x`,
            acceptance: "X is built and the result is back with Grokbot.",
            actor: "owner",
          }),
        ]
      : [
          child(commandId, "B", "register-eng", {
            type: "agent.register",
            agentId: "b3r-engineering",
            displayName: "B3R engineering",
            origin: "internal",
            role: "engineering",
            capabilities: ["build"],
            projectId,
          }),
          child(commandId, "B", "register-research", {
            type: "agent.register",
            agentId: "grokbot-research",
            displayName: "Grokbot research",
            origin: "external",
            role: "research",
            capabilities: ["research"],
            projectId,
          }),
          child(commandId, "B", "simulate", {
            type: "transport.simulate",
            agentId: "grokbot-research",
          }),
          child(commandId, "B", "delegate", {
            type: "delegate",
            correlationId: `scenario-b:${projectId}:do-y`,
            projectId,
            fromAgentId: "b3r-engineering",
            toAgentId: "grokbot-research",
            title: "Do Y",
            body: "Ask Grokbot's research agent to do Y.",
            acceptance: "Y is done and the result is back on this task.",
            actor: "owner",
          }),
          child(commandId, "B", "clarify", {
            type: "clarify",
            taskId: `task:scenario-b:${projectId}:do-y`,
            fromAgentId: "grokbot-research",
            body: "Which Y should be researched?",
          }),
          child(commandId, "B", "reply", {
            type: "reply",
            taskId: `task:scenario-b:${projectId}:do-y`,
            fromAgentId: "b3r-engineering",
            replyTo: `task:scenario-b:${projectId}:do-y:clarify`,
            body: "The Y named in the task.",
          }),
          child(commandId, "B", "result", {
            type: "result",
            taskId: `task:scenario-b:${projectId}:do-y`,
            fromAgentId: "grokbot-research",
            body: "Y is done.",
          }),
          child(commandId, "B", "accept", {
            type: "accept",
            taskId: `task:scenario-b:${projectId}:do-y`,
            acceptance: "Y is done and the result is back on this task.",
            actor: "owner",
          }),
        ];
  let current = state;
  for (const step of steps) {
    const result = applyOne(current, step);
    if (result.outcome === "rejected") return result;
    current = foldApplied(current, step, result);
  }
  current = remember(current, commandId, {});
  return applied(
    current,
    scenario === "A"
      ? "Scenario A recorded on a simulated transport."
      : "Scenario B recorded on a simulated transport.",
    false,
    "ALLOW",
  );
};

const foldApplied = (
  state: StoredState,
  command: CollaborationCommand,
  result: CollaborationCommandResult,
): StoredState => {
  if (result.idempotent || result.outcome === "rejected") return state;
  return replayCommand(state, command);
};

const replayCommand = (state: StoredState, command: CollaborationCommand): StoredState => {
  const result = applyOne(state, command);
  if (result.outcome === "rejected" || result.idempotent) return state;
  if (command.type === "scenario.rehearse") return state;
  const projected = result.snapshot;
  return {
    agents: projected.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      origin: agent.origin,
      role: agent.role,
      capabilities: agent.capabilities,
      connection: agent.connection,
      projectId: agent.projectId,
    })),
    tasks: projected.tasks,
    messages: projected.messages,
    appliedCommandIds: state.appliedCommandIds.includes(command.commandId)
      ? state.appliedCommandIds
      : [...state.appliedCommandIds, command.commandId],
  };
};

/**
 * Apply one command. Rehearsal replays its own steps, so callers persist the
 * outer command and fold with `foldCollaboration`.
 */
export const applyCollaboration = (
  state: StoredState,
  command: CollaborationCommand,
): CollaborationCommandResult => applyOne(state, command);

export const foldCollaboration = (
  commands: ReadonlyArray<CollaborationCommand>,
): CollaborationSnapshot => {
  let state = initialCollaboration();
  for (const command of commands) {
    const result = applyOne(state, command);
    if (result.outcome !== "applied") continue;
    state = {
      agents: result.snapshot.agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        origin: agent.origin,
        role: agent.role,
        capabilities: [...agent.capabilities],
        connection: agent.connection,
        projectId: agent.projectId,
      })),
      tasks: result.snapshot.tasks,
      messages: result.snapshot.messages,
      appliedCommandIds: state.appliedCommandIds.includes(command.commandId)
        ? state.appliedCommandIds
        : [...state.appliedCommandIds, command.commandId],
    };
  }
  return projectCollaboration(state);
};

export type { StoredState };
