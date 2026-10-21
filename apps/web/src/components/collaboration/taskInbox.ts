import { TaskContractReviewHint, type CollaborationTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
export const inboxAttention = [
  "all",
  "clarification",
  "waiting",
  "review",
  "paused",
  "failure",
  "accepted",
  "unknown",
] as const;
export type InboxAttention = (typeof inboxAttention)[number];
export const inboxAttentionLabel: Record<InboxAttention, string> = {
  all: "All tasks",
  clarification: "Clarification pending",
  waiting: "Recorded wait",
  review: "Review hint available",
  paused: "Paused revision",
  failure: "Persisted failure",
  accepted: "Accepted current revision",
  unknown: "Missing / unknown facts",
};
export type InboxKey = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly taskId: string;
};
export type InboxFilters = {
  readonly query: string;
  readonly projectId: string;
  readonly assigneeId: string;
  readonly attention: InboxAttention;
};
export const defaultInboxFilters: InboxFilters = {
  query: "",
  projectId: "",
  assigneeId: "",
  attention: "all",
};
export const inboxKey = (environmentId: string, task: CollaborationTask): InboxKey => ({
  environmentId,
  projectId: task.projectId,
  taskId: task.id,
});
export const inboxKeyText = (key: InboxKey) =>
  JSON.stringify([key.environmentId, key.projectId, key.taskId]);
const validHint = Schema.is(TaskContractReviewHint);
const searchText = (text: string) => text.normalize("NFKC").toLowerCase();
export function taskInboxFacts(
  task: CollaborationTask,
  environmentId: string,
  stale: boolean,
  ambiguous = false,
) {
  const contract = task.contractReadout?.status === "available" ? task.contractReadout : null;
  const result = task.resultReadout?.status === "available" ? task.resultReadout : null;
  const providerStatus =
    result && result.providerTurnId !== null ? result.providerTurnStatus : null;
  const hint = task.review;
  const reviewed = !!(
    contract &&
    task.threadId &&
    hint &&
    validHint(hint) &&
    hint.reference.environmentId === environmentId &&
    hint.reference.projectId === task.projectId &&
    hint.reference.taskId === task.id &&
    hint.revision === contract.contract.revision &&
    hint.actions.length > 0
  );
  const accepted = !!contract && contract.acceptedRevision === contract.contract.revision;
  const labels: Exclude<InboxAttention, "all">[] = [];
  if (task.pendingClarificationId !== null) labels.push("clarification");
  if (task.waitReason?.trim()) labels.push("waiting");
  if (reviewed) labels.push("review");
  if (contract?.phase === "redirected") labels.push("paused");
  if (
    result &&
    (result.runStatus === "failed" ||
      providerStatus === "failed" ||
      result.content.status === "failure")
  )
    labels.push("failure");
  if (accepted) labels.push("accepted");
  if (
    stale ||
    ambiguous ||
    !contract ||
    contract.phase === null ||
    !reviewed ||
    !result ||
    result.content.status === "unknown" ||
    providerStatus === null ||
    result.providerTurnId === null ||
    result.attemptId === null
  )
    labels.push("unknown");
  return {
    labels,
    ledger: task.state,
    outcome: result
      ? `Persisted run: ${result.runStatus}; provider turn: ${providerStatus ?? "unknown"}`
      : "Provider outcome: unknown / unavailable",
    acceptance: contract
      ? accepted
        ? `Owner acceptance recorded for current revision ${contract.contract.revision}`
        : `Owner acceptance: current revision ${contract.contract.revision} not recorded${contract.acceptedRevision !== null ? ` (recorded revision ${contract.acceptedRevision})` : ""}`
      : "Owner acceptance: unknown",
  };
}
export function resolveInboxSelection(
  tasks: ReadonlyArray<CollaborationTask>,
  environmentId: string,
  selection: InboxKey | null,
) {
  if (selection === null) return { status: "none" } as const;
  if (selection.environmentId !== environmentId)
    return {
      status: "unavailable",
      reason: "Selected task belongs to another environment. Choose a task in this inbox.",
    } as const;
  const matches = tasks.filter(
    (t) => t.id === selection.taskId && t.projectId === selection.projectId,
  );
  if (matches.length !== 1)
    return {
      status: "unavailable",
      reason:
        matches.length > 1
          ? "Selected task identity is ambiguous in this snapshot. No task controls were opened."
          : "Selected task is missing or deleted from this snapshot. No other task was selected.",
    } as const;
  return { status: "selected", task: matches[0]! } as const;
}
export type InboxChoice = { readonly id: string; readonly label: string };
function choices(current: ReadonlyArray<InboxChoice>, ids: ReadonlyArray<string>) {
  const values = new Map(current.map((c) => [c.id, c.label]));
  for (const id of ids)
    if (id && !values.has(id)) values.set(id, `${id} (not in current directory)`);
  return [...values].map(([id, label]) => ({ id, label }));
}
export function deriveTaskInbox(input: {
  environmentId: string;
  tasks: ReadonlyArray<CollaborationTask>;
  projects: ReadonlyArray<InboxChoice>;
  assignees: ReadonlyArray<InboxChoice>;
  filters: InboxFilters;
  stale: boolean;
}) {
  const identities = new Map<string, number>();
  for (const task of input.tasks) {
    const key = inboxKeyText(inboxKey(input.environmentId, task));
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  const query = searchText(input.filters.query.trim());
  const occurrences = new Map<string, number>();
  const base = input.tasks
    .map((task) => {
      const key = inboxKey(input.environmentId, task);
      const text = inboxKeyText(key);
      const ambiguous = identities.get(text) !== 1;
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      return {
        renderKey: ambiguous ? JSON.stringify([text, occurrence]) : text,
        task,
        key,
        ambiguous,
        facts: taskInboxFacts(task, input.environmentId, input.stale, ambiguous),
      };
    })
    .filter(
      (row) =>
        (!input.filters.projectId || row.task.projectId === input.filters.projectId) &&
        (!input.filters.assigneeId || row.task.assigneeAgentId === input.filters.assigneeId) &&
        (!query ||
          searchText(row.task.title).includes(query) ||
          searchText(row.task.id).includes(query)),
    );
  const counts: Record<InboxAttention, number> = {
    all: base.length,
    clarification: 0,
    waiting: 0,
    review: 0,
    paused: 0,
    failure: 0,
    accepted: 0,
    unknown: 0,
  };
  for (const row of base) for (const label of row.facts.labels) counts[label]++;
  return {
    rows: base.filter(
      (row) =>
        input.filters.attention === "all" || row.facts.labels.includes(input.filters.attention),
    ),
    counts,
    total: input.tasks.length,
    projects: choices(input.projects, [
      ...input.tasks.map((t) => t.projectId),
      input.filters.projectId,
    ]),
    assignees: choices(input.assignees, [
      ...input.tasks.map((t) => t.assigneeAgentId),
      input.filters.assigneeId,
    ]),
  };
}
