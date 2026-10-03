import { McpActionGateBlockedError, type ActionGateDecision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ActionGateService } from "../actionGate/ActionGateService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const requireAllowedMcpTool = (
  toolName: string,
  args: unknown,
): Effect.Effect<
  ActionGateDecision,
  McpActionGateBlockedError,
  McpInvocationContext.McpInvocationContext | ActionGateService
> =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const actionGate = yield* ActionGateService;
    const decision = yield* actionGate
      .authorizeTool({
        toolName,
        args,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
      })
      .pipe(
        Effect.mapError(
          () =>
            new McpActionGateBlockedError({
              toolName,
              decision: "DENY",
              reasonCodes: ["ACTION_DENIED"],
              detail: "ActionGate could not authorize this tool call.",
            }),
        ),
      );
    if (decision.decision !== "ALLOW") {
      return yield* new McpActionGateBlockedError({
        toolName,
        decision: decision.decision,
        reasonCodes: [...decision.reasonCodes],
        detail: decision.explanation,
        ...(decision.approvalId !== undefined ? { approvalId: decision.approvalId } : {}),
      });
    }
    return decision;
  });
