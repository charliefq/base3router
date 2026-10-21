/**
 * Server admission for a collaboration command.
 *
 * The authenticated principal and the server's project, thread, and provider
 * facts are the only authority. Client `actor`, `fromAgentId`, `admittedBy`,
 * and `gateDecision` are discarded before anything is stored.
 *
 * `ActionGate.authorizeTool` plans MCP tools. A chat command does not bind
 * one, and a made-up tool name would persist an invalid plan. Executable
 * delegation therefore stays DENY until a real tool plan exists. Recording a
 * message cannot turn that DENY into a running task.
 */
import type {
  CollaborationCommand,
  CollaborationGateDecision,
  CollaborationRejection,
} from "@t3tools/contracts";

export interface CollaborationProviderFact {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly executable: boolean;
}

export interface CollaborationFacts {
  readonly principalId: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<CollaborationProviderFact>;
  readonly threads: ReadonlyArray<{ readonly id: string; readonly projectId: string }>;
  readonly executionGate: CollaborationGateDecision;
}

/** Production chat delegation is not an execution tool. */
export const collaborationExecutionGate: CollaborationGateDecision = "DENY";

export type CollaborationSeal =
  | { readonly outcome: "sealed"; readonly command: CollaborationCommand }
  | {
      readonly outcome: "rejected";
      readonly code: CollaborationRejection;
      readonly detail: string;
    };

const productRefusal = (detail: string): CollaborationSeal => ({
  outcome: "rejected",
  code: "unauthorized",
  detail,
});

export const sealCollaborationCommand = (
  command: CollaborationCommand,
  facts: CollaborationFacts,
): CollaborationSeal => {
  const principalId = facts.principalId.trim();
  if (!principalId) {
    return productRefusal("The authenticated principal is missing.");
  }
  if (command.type === "task.enroll")
    return productRefusal("Task enrollment is owned by successful server governed creation.");
  if (
    command.type === "scenario.rehearse" ||
    command.type === "transport.simulate" ||
    command.type === "agent.register"
  ) {
    return productRefusal(
      "The product API does not persist a simulated rehearsal or a client-registered employee.",
    );
  }
  if (command.projectId && !facts.projectIds.includes(command.projectId)) {
    return productRefusal("That project is not available to this principal.");
  }

  const admitted = (
    fields: Omit<CollaborationCommand, "type" | "commandId" | "admissionSource" | "admittedBy">,
  ): CollaborationSeal => ({
    outcome: "sealed",
    command: {
      type: command.type,
      commandId: command.commandId,
      admissionSource: "server",
      admittedBy: principalId,
      ...fields,
    },
  });

  switch (command.type) {
    case "thread.bind": {
      if (!command.projectId || !command.threadId || !command.agentId) {
        return {
          outcome: "rejected",
          code: "not-ready",
          detail: "A thread bind names a project, a thread, and a provider.",
        };
      }
      const thread = facts.threads.find((item) => item.id === command.threadId);
      if (!thread || thread.projectId !== command.projectId) {
        return productRefusal("That thread is not in the selected project.");
      }
      if (command.agentId === "grokbot") {
        return {
          outcome: "rejected",
          code: "not-connected",
          detail: "Grokbot is NOT_CONNECTED. No thread was opened for it.",
        };
      }
      const provider = facts.providers.find((item) => item.id === command.agentId);
      if (!provider) {
        return {
          outcome: "rejected",
          code: "unknown-agent",
          detail: "That provider is not configured.",
        };
      }
      if (!provider.executable) {
        return {
          outcome: "rejected",
          code: "not-connected",
          detail: "That provider is not ready. No conversation was fabricated.",
        };
      }
      return admitted({
        agentId: provider.id,
        displayName: provider.displayName,
        origin: "internal",
        role: "provider",
        capabilities: [...provider.capabilities],
        projectId: command.projectId,
        threadId: command.threadId,
        title: command.title ?? provider.displayName,
        gateDecision: "DENY",
      });
    }
    case "delegate":
    case "resolve": {
      if (
        !command.projectId ||
        !command.correlationId ||
        !command.title ||
        !command.body ||
        !command.acceptance ||
        (command.type === "delegate" && !command.toAgentId) ||
        (command.type === "resolve" && !command.name)
      ) {
        return {
          outcome: "rejected",
          code: "not-ready",
          detail: "Delegation needs a project, one target, and a body.",
        };
      }
      if (command.toAgentId === "grokbot" || command.name === "Grokbot") {
        return {
          outcome: "rejected",
          code: "not-connected",
          detail: "Grokbot is NOT_CONNECTED. The request was not sent.",
        };
      }
      if (command.toAgentId) {
        const provider = facts.providers.find((item) => item.id === command.toAgentId);
        if (!provider) {
          return {
            outcome: "rejected",
            code: "unknown-agent",
            detail: "That provider is not configured.",
          };
        }
        if (!provider.executable) {
          return {
            outcome: "rejected",
            code: "not-connected",
            detail: "That provider is not ready. No work was dispatched.",
          };
        }
      }
      return admitted({
        projectId: command.projectId,
        correlationId: command.correlationId,
        ...(command.toAgentId ? { toAgentId: command.toAgentId } : {}),
        ...(command.name ? { name: command.name } : {}),
        title: command.title,
        body: command.body,
        acceptance: command.acceptance,
        gateDecision: facts.executionGate,
      });
    }
    case "clarify":
    case "result": {
      if (!command.taskId || !command.body) {
        return {
          outcome: "rejected",
          code: "not-ready",
          detail: "The command names a task and a body.",
        };
      }
      return admitted({
        taskId: command.taskId,
        body: command.body,
        ...(command.projectId ? { projectId: command.projectId } : {}),
      });
    }
    case "reply": {
      if (!command.taskId || !command.body || !command.replyTo || command.revision === undefined) {
        return {
          outcome: "rejected",
          code: "not-ready",
          detail: "A reply cites the current clarification and its revision.",
        };
      }
      return admitted({
        taskId: command.taskId,
        body: command.body,
        replyTo: command.replyTo,
        revision: command.revision,
        ...(command.projectId ? { projectId: command.projectId } : {}),
      });
    }
    case "accept": {
      if (!command.taskId || !command.acceptance) {
        return {
          outcome: "rejected",
          code: "not-ready",
          detail: "Acceptance names the task and the outcome.",
        };
      }
      return admitted({
        taskId: command.taskId,
        acceptance: command.acceptance,
        ...(command.projectId ? { projectId: command.projectId } : {}),
      });
    }
  }
};
