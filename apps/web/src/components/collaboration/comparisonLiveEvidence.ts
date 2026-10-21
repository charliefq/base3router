import {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { TaskResultComparison } from "@t3tools/shared/taskResultComparison";
import * as Schema from "effect/Schema";

const {
  messages: _messages,
  turnItems: _items,
  visibleTurnItems: _visible,
  plans: _plans,
  contextHandoffs: _handoffs,
  eventSequence: _sequence,
  ...controlFields
} = OrchestrationV2ThreadProjection.fields;
const validProjection = Schema.is(OrchestrationV2ThreadProjection);
const sameControl = Schema.toEquivalence(Schema.Struct(controlFields));
const sameMessage = Schema.toEquivalence(OrchestrationV2ConversationMessage);
const sameItem = Schema.toEquivalence(OrchestrationV2TurnItem);

/** Bounded live state omits history; only observed pair bodies can contradict full RPC evidence. */
export function comparisonLiveEvidenceAgrees(
  full: OrchestrationV2ThreadProjection,
  live: OrchestrationV2ThreadProjection,
  pair: Extract<TaskResultComparison, { status: "available" }>,
) {
  if (!validProjection(live) || !sameControl(full, live)) return false;
  if (
    new Set(live.messages.map((v) => v.id)).size !== live.messages.length ||
    new Set(live.turnItems.map((v) => v.id)).size !== live.turnItems.length
  )
    return false;
  // Production bounded snapshots always retain the latest run's user message.
  if (!live.messages.some((v) => v.id === pair.current.identity.messageId)) return false;
  const identities = [pair.previous.identity, pair.current.identity];
  const messageIds = new Set(identities.map((v) => v.messageId));
  const itemIds = new Set(identities.map((v) => v.itemId));
  const runIds = new Set(identities.map((v) => v.runId));
  for (const message of live.messages) {
    if (!messageIds.has(message.id)) continue;
    const original = full.messages.find((v) => v.id === message.id);
    if (!original || !sameMessage(original, message)) return false;
  }
  for (const item of live.turnItems) {
    if (
      !itemIds.has(item.id) &&
      !(item.type === "assistant_message" && item.runId !== null && runIds.has(item.runId))
    )
      continue;
    const original = full.turnItems.find((v) => v.id === item.id);
    if (!original || !sameItem(original, item)) return false;
  }
  return true;
}
