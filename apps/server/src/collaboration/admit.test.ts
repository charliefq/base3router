import { describe, expect, it } from "vite-plus/test";

import type { CollaborationCommand } from "@t3tools/contracts";

import {
  collaborationExecutionGate,
  sealCollaborationCommand,
  type CollaborationFacts,
} from "./admit.ts";

const facts = (overrides: Partial<CollaborationFacts> = {}): CollaborationFacts => ({
  principalId: "principal-owner",
  projectIds: ["project-a"],
  providers: [
    {
      id: "provider-codex",
      displayName: "Codex",
      capabilities: ["gpt"],
      executable: true,
    },
    {
      id: "provider-offline",
      displayName: "Offline",
      capabilities: [],
      executable: false,
    },
  ],
  threads: [{ id: "thread-1", projectId: "project-a" }],
  executionGate: collaborationExecutionGate,
  ...overrides,
});

describe("collaboration admission", () => {
  it("drops client authority and keeps the production execution gate at DENY", () => {
    const client: CollaborationCommand = {
      type: "delegate",
      commandId: "send-1",
      actor: "owner",
      fromAgentId: "spoofed-agent",
      admittedBy: "spoofed-principal",
      admissionSource: "server",
      gateDecision: "ALLOW",
      toAgentId: "provider-codex",
      projectId: "project-a",
      correlationId: "build-x",
      title: "Build X",
      body: "Build X.",
      acceptance: "X exists.",
    };
    const sealed = sealCollaborationCommand(client, facts());
    expect(collaborationExecutionGate).toBe("DENY");
    expect(sealed).toMatchObject({
      outcome: "sealed",
      command: {
        admittedBy: "principal-owner",
        admissionSource: "server",
        gateDecision: "DENY",
        toAgentId: "provider-codex",
      },
    });
    if (sealed.outcome === "sealed") {
      expect(sealed.command.actor).toBeUndefined();
      expect(sealed.command.fromAgentId).toBeUndefined();
    }
  });

  it("refuses an unknown project, a foreign thread, a disconnected provider, and a rehearsal", () => {
    expect(
      sealCollaborationCommand(
        {
          type: "thread.bind",
          commandId: "bind-foreign-project",
          projectId: "other-project",
          threadId: "thread-1",
          agentId: "provider-codex",
        },
        facts(),
      ),
    ).toMatchObject({ outcome: "rejected", code: "unauthorized" });

    expect(
      sealCollaborationCommand(
        {
          type: "thread.bind",
          commandId: "bind-foreign-thread",
          projectId: "project-a",
          threadId: "missing-thread",
          agentId: "provider-codex",
        },
        facts(),
      ),
    ).toMatchObject({ outcome: "rejected", code: "unauthorized" });

    const offline = sealCollaborationCommand(
      {
        type: "thread.bind",
        commandId: "bind-offline",
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-offline",
        displayName: "Pretend employee",
      },
      facts(),
    );
    expect(offline).toMatchObject({ outcome: "rejected", code: "not-connected" });

    expect(
      sealCollaborationCommand(
        {
          type: "thread.bind",
          commandId: "bind-grokbot",
          projectId: "project-a",
          threadId: "thread-1",
          agentId: "grokbot",
        },
        facts(),
      ),
    ).toMatchObject({ outcome: "rejected", code: "not-connected" });

    expect(
      sealCollaborationCommand(
        { type: "scenario.rehearse", commandId: "rehearse", scenario: "A", projectId: "project-a" },
        facts(),
      ),
    ).toMatchObject({ outcome: "rejected", code: "unauthorized" });
  });

  it("copies the configured provider identity onto a sealed thread bind", () => {
    const sealed = sealCollaborationCommand(
      {
        type: "thread.bind",
        commandId: "bind-codex",
        projectId: "project-a",
        threadId: "thread-1",
        agentId: "provider-codex",
        displayName: "Not Codex",
        fromAgentId: "spoofed-agent",
      },
      facts(),
    );
    expect(sealed).toMatchObject({
      outcome: "sealed",
      command: {
        displayName: "Codex",
        origin: "internal",
        capabilities: ["gpt"],
        threadId: "thread-1",
        projectId: "project-a",
        admittedBy: "principal-owner",
        gateDecision: "DENY",
      },
    });
  });
});
