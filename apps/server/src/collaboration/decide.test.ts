import { describe, expect, it } from "vite-plus/test";

import {
  applyCollaboration,
  foldCollaboration,
  initialCollaboration,
  projectCollaboration,
} from "./decide.ts";

const projectId = "project-a";

describe("collaboration", () => {
  it("keeps real Grokbot disconnected and does not invent an internal employee", () => {
    const snapshot = projectCollaboration(initialCollaboration());
    expect(snapshot.realGrokbot).toBe("NOT_CONNECTED");
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["grokbot"]);
    expect(snapshot.agents[0]).toMatchObject({
      origin: "external",
      connection: "NOT_CONNECTED",
      availability: "offline",
    });
    expect(snapshot.grokbotIntegration.length).toBeGreaterThan(0);
  });

  it("rehearses an inbound delegation with clarification, reply, and result", () => {
    const snapshot = foldCollaboration([
      {
        type: "scenario.rehearse",
        commandId: "rehearse-a",
        scenario: "A",
        projectId,
      },
    ]);
    const task = snapshot.tasks.find((item) => item.title === "Build X");
    expect(task).toMatchObject({
      state: "completed",
      ownerAgentId: "grokbot",
      assigneeAgentId: "b3r-engineering",
      projectId,
      gateDecision: "ALLOW",
    });
    expect(snapshot.messages.map((message) => message.kind)).toEqual([
      "delegation",
      "clarification",
      "reply",
      "result",
    ]);
    expect(snapshot.messages.every((message) => message.grantsExecution === false)).toBe(true);
    expect(snapshot.messages.every((message) => message.transport === "simulated")).toBe(true);
    expect(snapshot.realGrokbot).toBe("NOT_CONNECTED");
    expect(snapshot.agents.find((agent) => agent.id === "grokbot")?.connection).toBe("SIMULATED");
    const reply = snapshot.messages.find((message) => message.kind === "reply");
    expect(reply?.replyTo).toBe(
      snapshot.messages.find((message) => message.kind === "clarification")?.id,
    );
    expect(snapshot.tasks).toHaveLength(1);
  });

  it("rehearses an outbound request and returns the result to the original task", () => {
    const snapshot = foldCollaboration([
      {
        type: "scenario.rehearse",
        commandId: "rehearse-b",
        scenario: "B",
        projectId,
      },
    ]);
    const task = snapshot.tasks.find((item) => item.title === "Do Y");
    expect(task).toMatchObject({
      state: "completed",
      ownerAgentId: "b3r-engineering",
      assigneeAgentId: "grokbot-research",
    });
    const result = snapshot.messages.find((message) => message.kind === "result");
    expect(result).toMatchObject({
      senderId: "grokbot-research",
      recipientId: "b3r-engineering",
      taskId: task?.id,
      transport: "simulated",
      grantsExecution: false,
    });
    expect(snapshot.realGrokbot).toBe("NOT_CONNECTED");
  });

  it("does not send twice after a restart or a repeated correlation", () => {
    const delegate = {
      type: "agent.register" as const,
      commandId: "register-eng",
      agentId: "b3r-engineering",
      displayName: "B3R engineering",
      origin: "internal" as const,
      role: "engineering",
      capabilities: ["build"],
      projectId,
    };
    const send = {
      type: "delegate" as const,
      commandId: "send-1",
      correlationId: "build-x",
      projectId,
      fromAgentId: "b3r-engineering",
      toAgentId: "b3r-engineering",
      title: "Build X",
      body: "Build X locally.",
      acceptance: "X exists.",
      actor: "owner" as const,
    };
    const once = foldCollaboration([delegate, send, send, { ...send, commandId: "send-2" }]);
    expect(once.tasks).toHaveLength(1);
    expect(once.messages).toHaveLength(1);
    const restarted = applyCollaboration(
      {
        agents: once.agents.map((agent) => ({
          id: agent.id,
          displayName: agent.displayName,
          origin: agent.origin,
          role: agent.role,
          capabilities: agent.capabilities,
          connection: agent.connection,
          projectId: agent.projectId,
        })),
        tasks: once.tasks,
        messages: once.messages,
        appliedCommandIds: ["register-eng", "send-1", "send-2"],
      },
      send,
    );
    expect(restarted.idempotent).toBe(true);
    expect(restarted.snapshot.messages).toHaveLength(1);
  });

  it("refuses a disconnected contractor, an ambiguous name, and a cross-project target", () => {
    let state = initialCollaboration();
    const disconnected = applyCollaboration(state, {
      type: "delegate",
      commandId: "to-grokbot",
      correlationId: "ask-grokbot",
      projectId,
      fromAgentId: "grokbot",
      toAgentId: "grokbot",
      title: "Ask",
      body: "Do it.",
      acceptance: "Done.",
      actor: "owner",
    });
    expect(disconnected).toMatchObject({
      outcome: "rejected",
      code: "not-connected",
      gateDecision: "DENY",
    });
    expect(disconnected.snapshot.tasks).toHaveLength(0);

    const registered = applyCollaboration(state, {
      type: "agent.register",
      commandId: "research-a",
      agentId: "research-a",
      displayName: "Research",
      origin: "internal",
      role: "research",
      capabilities: ["research"],
      projectId,
    });
    expect(registered.outcome).toBe("applied");
    state = {
      agents: registered.snapshot.agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        origin: agent.origin,
        role: agent.role,
        capabilities: agent.capabilities,
        connection: agent.connection,
        projectId: agent.projectId,
      })),
      tasks: [],
      messages: [],
      appliedCommandIds: ["research-a"],
    };
    const second = applyCollaboration(state, {
      type: "agent.register",
      commandId: "research-b",
      agentId: "research-b",
      displayName: "Research",
      origin: "external",
      role: "research",
      capabilities: ["research"],
      projectId: "project-b",
    });
    expect(second.outcome).toBe("applied");
    state = {
      agents: second.snapshot.agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        origin: agent.origin,
        role: agent.role,
        capabilities: agent.capabilities,
        connection: agent.connection,
        projectId: agent.projectId,
      })),
      tasks: [],
      messages: [],
      appliedCommandIds: ["research-a", "research-b"],
    };
    const ambiguous = applyCollaboration(state, {
      type: "resolve",
      commandId: "resolve-research",
      correlationId: "which-research",
      projectId,
      fromAgentId: "grokbot",
      name: "Research",
      title: "Do Y",
      body: "Do Y.",
      acceptance: "Y is done.",
      actor: "owner",
    });
    expect(ambiguous).toMatchObject({ outcome: "rejected", code: "ambiguous-target" });
    expect(ambiguous.snapshot.tasks).toHaveLength(0);

    const crossed = applyCollaboration(state, {
      type: "delegate",
      commandId: "cross",
      correlationId: "cross-project",
      projectId,
      fromAgentId: "research-a",
      toAgentId: "research-b",
      title: "Do Y",
      body: "Do Y in the other project.",
      acceptance: "Y is done.",
      actor: "owner",
    });
    expect(crossed).toMatchObject({
      outcome: "rejected",
      code: "cross-project",
      gateDecision: "DENY",
    });
    expect(crossed.snapshot.tasks).toHaveLength(0);
  });

  it("rejects a command that omits the fields its type needs", () => {
    const result = applyCollaboration(initialCollaboration(), {
      type: "agent.register",
      commandId: "incomplete",
    });
    expect(result).toMatchObject({ outcome: "rejected", code: "not-ready", gateDecision: null });
    expect(result.snapshot.agents.map((agent) => agent.id)).toEqual(["grokbot"]);
  });
});
