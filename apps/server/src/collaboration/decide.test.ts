import { describe, expect, it } from "vite-plus/test";

import type { CollaborationCommand } from "@t3tools/contracts";

import {
  applyCollaboration,
  foldCollaboration,
  foldCollaborationState,
  initialCollaboration,
  projectCollaboration,
} from "./decide.ts";

const projectId = "project-a";
const owner = "principal-owner";
const providerId = "provider-codex";

const seal = (command: CollaborationCommand, admittedBy = owner): CollaborationCommand => ({
  ...command,
  admissionSource: "server",
  admittedBy,
});

const bind = seal({
  type: "thread.bind",
  commandId: "bind-codex",
  agentId: providerId,
  displayName: "Codex",
  origin: "internal",
  role: "provider",
  capabilities: ["gpt"],
  projectId,
  threadId: "thread-1",
  title: "Chat with Codex",
  gateDecision: "DENY",
});

const delegate = (gate: "ALLOW" | "DENY", commandId = "send-1"): CollaborationCommand =>
  seal({
    type: "delegate",
    commandId,
    correlationId: "build-x",
    projectId,
    toAgentId: providerId,
    title: "Build X",
    body: "Build X on this thread.",
    acceptance: "X exists.",
    gateDecision: gate,
    actor: "owner",
    fromAgentId: "spoofed-agent",
  });

describe("collaboration", () => {
  it("keeps real Grokbot disconnected and does not invent an internal employee", () => {
    const snapshot = projectCollaboration(initialCollaboration());
    expect(snapshot.realGrokbot).toBe("NOT_CONNECTED");
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["grokbot"]);
    expect(snapshot.agents[0]).toMatchObject({
      origin: "external",
      connection: "NOT_CONNECTED",
      availability: "offline",
      threadId: null,
    });
  });

  it("links a provider to a persisted thread without granting execution", () => {
    const snapshot = foldCollaboration([bind]);
    expect(snapshot.agents.find((agent) => agent.id === providerId)).toMatchObject({
      origin: "internal",
      threadId: "thread-1",
      projectId,
    });
    expect(snapshot.tasks[0]).toMatchObject({
      title: "Chat with Codex",
      ownerAgentId: owner,
      assigneeAgentId: providerId,
      projectId,
      threadId: "thread-1",
      state: "blocked",
      gateDecision: "DENY",
      pendingClarificationId: null,
    });
    expect(snapshot.realGrokbot).toBe("NOT_CONNECTED");
  });

  it("does not let a client actor or fromAgentId admit a running task", () => {
    const client = applyCollaboration(foldCollaborationState([bind]), {
      type: "delegate",
      commandId: "client-send",
      actor: "owner",
      fromAgentId: providerId,
      toAgentId: providerId,
      projectId,
      correlationId: "client",
      title: "Build X",
      body: "Build X.",
      acceptance: "X exists.",
      gateDecision: "ALLOW",
    });
    expect(client).toMatchObject({
      outcome: "rejected",
      code: "unauthorized",
      gateDecision: "DENY",
    });
    expect(client.snapshot.tasks).toHaveLength(1);
    expect(client.snapshot.tasks[0]?.state).toBe("blocked");
  });

  it("keeps a DENY gate blocked and refuses to clarify it into running work", () => {
    const snapshot = foldCollaboration([bind, delegate("DENY")]);
    expect(snapshot.tasks.find((task) => task.title === "Build X")).toMatchObject({
      state: "blocked",
      gateDecision: "DENY",
      ownerAgentId: owner,
      threadId: "thread-1",
    });
    expect(snapshot.messages[0]).toMatchObject({
      kind: "delegation",
      senderId: owner,
      grantsExecution: false,
      transport: "internal",
    });
    const task = snapshot.tasks.find((item) => item.title === "Build X");
    const clarified = applyCollaboration(
      foldCollaborationState([bind, delegate("DENY")]),
      seal(
        { type: "clarify", commandId: "clarify-denied", taskId: task?.id ?? "", body: "Which X?" },
        providerId,
      ),
    );
    expect(clarified).toMatchObject({ outcome: "rejected", code: "not-ready" });
    expect(clarified.snapshot.tasks.find((item) => item.id === task?.id)?.state).toBe("blocked");
  });

  it("answers two clarification rounds and rejects a stale, spoofed, or repeated reply", () => {
    const opened = foldCollaborationState([bind, delegate("ALLOW")]);
    const taskId = projectCollaboration(opened).tasks.find((task) => task.title === "Build X")?.id;
    expect(taskId).toBeTruthy();
    const clarify = (commandId: string, body: string) =>
      seal({ type: "clarify", commandId, taskId: taskId ?? "", body }, providerId);

    const firstQuestion = applyCollaboration(opened, clarify("clarify-1", "Which X?"));
    expect(firstQuestion.outcome).toBe("applied");
    const firstId = firstQuestion.snapshot.messages.find(
      (message) => message.kind === "clarification",
    )?.id;
    const blocked = firstQuestion.snapshot.tasks.find((task) => task.id === taskId);
    expect(firstId).toBe(`${taskId}:clarify:clarify-1`);
    expect(blocked).toMatchObject({
      state: "blocked",
      pendingClarificationId: firstId,
      revision: 2,
    });

    const afterFirst = foldCollaborationState([
      bind,
      delegate("ALLOW"),
      clarify("clarify-1", "Which X?"),
    ]);
    const delegationId = projectCollaboration(afterFirst).messages.find(
      (message) => message.kind === "delegation",
    )?.id;
    const staleTarget = applyCollaboration(
      afterFirst,
      seal({
        type: "reply",
        commandId: "reply-delegation",
        taskId: taskId ?? "",
        replyTo: delegationId ?? "",
        revision: blocked?.revision ?? 0,
        body: "The delegation itself.",
      }),
    );
    expect(staleTarget).toMatchObject({ outcome: "rejected", code: "not-ready" });
    expect(
      staleTarget.snapshot.tasks.find((task) => task.id === taskId)?.pendingClarificationId,
    ).toBe(firstId);

    const spoofed = applyCollaboration(
      afterFirst,
      seal(
        {
          type: "reply",
          commandId: "reply-spoof",
          taskId: taskId ?? "",
          replyTo: firstId ?? "",
          revision: blocked?.revision ?? 0,
          body: "I pretend to be the owner.",
          fromAgentId: owner,
        },
        "someone-else",
      ),
    );
    expect(spoofed).toMatchObject({ outcome: "rejected", code: "unauthorized" });
    expect(spoofed.snapshot.messages.filter((message) => message.kind === "reply")).toHaveLength(0);

    const answer = seal({
      type: "reply",
      commandId: "reply-1",
      taskId: taskId ?? "",
      replyTo: firstId ?? "",
      revision: blocked?.revision ?? 0,
      body: "The X in the title.",
      fromAgentId: "not-the-owner",
    });
    const answered = applyCollaboration(afterFirst, answer);
    expect(answered.outcome).toBe("applied");
    expect(answered.snapshot.tasks.find((task) => task.id === taskId)).toMatchObject({
      state: "running",
      pendingClarificationId: null,
    });
    expect(answered.snapshot.messages.find((message) => message.kind === "reply")?.senderId).toBe(
      owner,
    );

    const second = clarify("clarify-2", "Which file?");
    const askedAgain = applyCollaboration(
      foldCollaborationState([bind, delegate("ALLOW"), clarify("clarify-1", "Which X?"), answer]),
      second,
    );
    const questions = askedAgain.snapshot.messages.filter(
      (message) => message.kind === "clarification",
    );
    expect(questions.map((message) => message.id)).toEqual([
      `${taskId}:clarify:clarify-1`,
      `${taskId}:clarify:clarify-2`,
    ]);
    const current = askedAgain.snapshot.tasks.find((task) => task.id === taskId);
    expect(current?.pendingClarificationId).toBe(`${taskId}:clarify:clarify-2`);

    const oldQuestion = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
      ]),
      seal({
        type: "reply",
        commandId: "reply-old",
        taskId: taskId ?? "",
        replyTo: firstId ?? "",
        revision: current?.revision ?? 0,
        body: "Answer to the first question.",
      }),
    );
    expect(oldQuestion).toMatchObject({ outcome: "rejected", code: "not-ready" });
    expect(
      oldQuestion.snapshot.tasks.find((task) => task.id === taskId)?.pendingClarificationId,
    ).toBe(`${taskId}:clarify:clarify-2`);

    const oldRevision = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
      ]),
      seal({
        type: "reply",
        commandId: "reply-old-revision",
        taskId: taskId ?? "",
        replyTo: `${taskId}:clarify:clarify-2`,
        revision: blocked?.revision ?? 0,
        body: "A revision from the first round.",
      }),
    );
    expect(oldRevision).toMatchObject({ outcome: "rejected", code: "not-ready" });
    expect(
      oldRevision.snapshot.messages.filter((message) => message.kind === "reply"),
    ).toHaveLength(1);

    const secondAnswer = seal({
      type: "reply",
      commandId: "reply-2",
      taskId: taskId ?? "",
      replyTo: `${taskId}:clarify:clarify-2`,
      revision: current?.revision ?? 0,
      body: "The file named X.",
    });
    const resumed = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
      ]),
      secondAnswer,
    );
    expect(resumed.snapshot.tasks.find((task) => task.id === taskId)?.state).toBe("running");

    const returned = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
        secondAnswer,
      ]),
      seal(
        { type: "result", commandId: "result-1", taskId: taskId ?? "", body: "X is built." },
        providerId,
      ),
    );
    expect(returned.snapshot.tasks.find((task) => task.id === taskId)).toMatchObject({
      state: "review-ready",
    });
    expect(returned.snapshot.messages.find((message) => message.kind === "result")).toMatchObject({
      senderId: providerId,
      recipientId: owner,
      grantsExecution: false,
    });
    const accepted = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
        secondAnswer,
        seal(
          { type: "result", commandId: "result-1", taskId: taskId ?? "", body: "X is built." },
          providerId,
        ),
      ]),
      seal({
        type: "accept",
        commandId: "accept-1",
        taskId: taskId ?? "",
        acceptance: "X is built.",
      }),
    );
    expect(accepted.snapshot.tasks.find((task) => task.id === taskId)?.state).toBe("completed");

    const replayed = applyCollaboration(
      foldCollaborationState([
        bind,
        delegate("ALLOW"),
        clarify("clarify-1", "Which X?"),
        answer,
        second,
        secondAnswer,
      ]),
      clarify("clarify-1", "Which X?"),
    );
    expect(replayed.idempotent).toBe(true);
    expect(
      replayed.snapshot.messages.filter((message) => message.kind === "clarification"),
    ).toHaveLength(2);
  });

  it("does not create a second task for the same correlation or a repeated command", () => {
    const once = foldCollaboration([bind, delegate("ALLOW"), delegate("ALLOW", "send-2")]);
    expect(once.tasks.filter((task) => task.correlationId === "build-x")).toHaveLength(1);
    expect(once.messages).toHaveLength(1);
    const restarted = applyCollaboration(
      foldCollaborationState([bind, delegate("ALLOW"), delegate("ALLOW", "send-2")]),
      delegate("ALLOW"),
    );
    expect(restarted.idempotent).toBe(true);
    expect(restarted.snapshot.messages).toHaveLength(1);
  });

  it("refuses Grokbot, an ambiguous name, a cross-project target, and a rehearsal", () => {
    const disconnected = applyCollaboration(
      initialCollaboration(),
      seal({
        type: "delegate",
        commandId: "to-grokbot",
        correlationId: "ask-grokbot",
        projectId,
        toAgentId: "grokbot",
        title: "Ask",
        body: "Do it.",
        acceptance: "Done.",
        gateDecision: "ALLOW",
      }),
    );
    expect(disconnected).toMatchObject({ outcome: "rejected", code: "not-connected" });
    expect(disconnected.snapshot.tasks).toHaveLength(0);
    expect(disconnected.snapshot.realGrokbot).toBe("NOT_CONNECTED");

    const directory = foldCollaborationState([
      bind,
      seal({
        type: "thread.bind",
        commandId: "bind-research-a",
        agentId: "research-a",
        displayName: "Research",
        origin: "internal",
        role: "provider",
        capabilities: ["search"],
        projectId,
        threadId: "thread-a",
        gateDecision: "DENY",
      }),
      seal({
        type: "thread.bind",
        commandId: "bind-research-b",
        agentId: "research-b",
        displayName: "Research",
        origin: "internal",
        role: "provider",
        capabilities: ["search"],
        projectId: "project-b",
        threadId: "thread-b",
        gateDecision: "DENY",
      }),
    ]);
    const ambiguous = applyCollaboration(
      directory,
      seal({
        type: "resolve",
        commandId: "resolve-research",
        name: "Research",
        projectId,
        correlationId: "which-research",
        title: "Do Y",
        body: "Do Y.",
        acceptance: "Y is done.",
        gateDecision: "ALLOW",
      }),
    );
    expect(ambiguous).toMatchObject({ outcome: "rejected", code: "ambiguous-target" });

    const crossed = applyCollaboration(
      directory,
      seal({
        type: "delegate",
        commandId: "cross",
        toAgentId: "research-b",
        projectId,
        correlationId: "cross-project",
        title: "Do Y",
        body: "Do Y in the other project.",
        acceptance: "Y is done.",
        gateDecision: "ALLOW",
      }),
    );
    expect(crossed).toMatchObject({ outcome: "rejected", code: "cross-project" });
    expect(crossed.snapshot.tasks.some((task) => task.correlationId === "cross-project")).toBe(
      false,
    );

    const rehearsal = applyCollaboration(
      initialCollaboration(),
      seal({ type: "scenario.rehearse", commandId: "rehearse", scenario: "A", projectId }),
    );
    expect(rehearsal).toMatchObject({ outcome: "rejected", code: "unauthorized" });
    expect(rehearsal.snapshot.agents.map((agent) => agent.id)).toEqual(["grokbot"]);
  });
});
