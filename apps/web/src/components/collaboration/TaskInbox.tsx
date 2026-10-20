import { useState, type ReactNode } from "react";
import type { CollaborationTask } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  defaultInboxFilters,
  deriveTaskInbox,
  inboxAttention,
  inboxAttentionLabel,
  inboxKeyText,
  resolveInboxSelection,
  type InboxKey,
  type InboxChoice,
} from "./taskInbox";
export function TaskInbox(props: {
  environmentId: string;
  tasks: ReadonlyArray<CollaborationTask>;
  projects: ReadonlyArray<InboxChoice>;
  assignees: ReadonlyArray<InboxChoice>;
  stale: boolean;
  selection: InboxKey | null;
  onSelect: (key: InboxKey) => void;
  onBack: () => void;
  renderDetail: (task: CollaborationTask) => ReactNode;
}) {
  const [filters, setFilters] = useState(defaultInboxFilters);
  const inbox = deriveTaskInbox({ ...props, filters });
  const selected = resolveInboxSelection(props.tasks, props.environmentId, props.selection);
  const choice = (value: string | null, choices: ReadonlyArray<InboxChoice>) =>
    choices.find((c) => JSON.stringify(c.id) === value)?.id ?? "";
  return (
    <section aria-label="Task inbox" className="space-y-4">
      <h2>Task inbox</h2>
      <p>
        These read-only list filters are separate from task creation scope. Attention labels can
        overlap and grant no execution or acceptance. A paused revision is a contract phase, not
        confirmed provider termination.
      </p>
      {props.stale ? (
        <p role="status">
          Stale inbox facts — current outcomes and attention needs are UNKNOWN. Displayed labels
          describe the last snapshot.
        </p>
      ) : null}
      <fieldset aria-label="Task inbox filters" className="flex flex-wrap gap-3">
        <label>
          Search title or task ID
          <Input
            aria-label="Inbox search"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
        </label>
        <label>
          Inbox project
          <Select
            value={filters.projectId ? JSON.stringify(filters.projectId) : "all"}
            onValueChange={(value) =>
              setFilters({ ...filters, projectId: choice(value, inbox.projects) })
            }
          >
            <SelectTrigger aria-label="Inbox project">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All projects</SelectItem>
              {inbox.projects.map((c) => (
                <SelectItem key={c.id} value={JSON.stringify(c.id)}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label>
          Inbox assignee
          <Select
            value={filters.assigneeId ? JSON.stringify(filters.assigneeId) : "all"}
            onValueChange={(value) =>
              setFilters({ ...filters, assigneeId: choice(value, inbox.assignees) })
            }
          >
            <SelectTrigger aria-label="Inbox assignee">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All assignees</SelectItem>
              {inbox.assignees.map((c) => (
                <SelectItem key={c.id} value={JSON.stringify(c.id)}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <Button type="button" variant="outline" onClick={() => setFilters(defaultInboxFilters)}>
          Reset inbox filters
        </Button>
      </fieldset>
      <div aria-label="Inbox attention filters" className="flex flex-wrap gap-2">
        {inboxAttention.map((attention) => (
          <Button
            key={attention}
            type="button"
            size="sm"
            variant={filters.attention === attention ? "secondary" : "outline"}
            aria-pressed={filters.attention === attention}
            onClick={() => setFilters({ ...filters, attention })}
          >
            {inboxAttentionLabel[attention]} ({inbox.counts[attention]})
          </Button>
        ))}
      </div>
      <p role="status">
        {inbox.rows.length} matching / {inbox.total} total tasks. Attention counts overlap within
        the current search, project and assignee filters.
      </p>
      {inbox.rows.length === 0 ? (
        <p>No tasks match these inbox filters.</p>
      ) : (
        <ul aria-label="Task inbox rows" className="space-y-2">
          {inbox.rows.map((row) => (
            <li key={row.renderKey} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 wrap-anywhere text-sm font-medium">{row.task.title}</h3>
                <Button
                  type="button"
                  variant="outline"
                  disabled={row.ambiguous}
                  aria-label={`View task ${row.task.id} in ${row.task.projectId}`}
                  data-task-inbox-open={inboxKeyText(row.key)}
                  onClick={() => props.onSelect(row.key)}
                >
                  View task
                </Button>
              </div>
              <p className="wrap-anywhere">
                {row.task.id} · Project {row.task.projectId} · Assignee {row.task.assigneeAgentId}
              </p>
              <p className="wrap-anywhere">
                Command ledger: {row.facts.ledger}. {row.facts.outcome}. {row.facts.acceptance}.
              </p>
              <p>
                {row.facts.labels.map((label) => inboxAttentionLabel[label]).join(" · ") ||
                  "No attention label recorded"}
                {props.stale ? " · Stale snapshot" : ""}
              </p>
              {row.ambiguous ? <p>Ambiguous task identity; controls unavailable.</p> : null}
            </li>
          ))}
        </ul>
      )}
      {selected.status !== "none" ? (
        <section aria-label="Selected task details" className="space-y-3">
          <Button type="button" variant="outline" onClick={props.onBack}>
            Back to task inbox
          </Button>
          {selected.status === "unavailable" ? (
            <p role="status">{selected.reason}</p>
          ) : (
            <>
              {!inbox.rows.some(
                (row) => inboxKeyText(row.key) === inboxKeyText(props.selection!),
              ) ? (
                <p>Selected task is outside the current filters. Focus has not moved.</p>
              ) : null}
              {props.renderDetail(selected.task)}
            </>
          )}
        </section>
      ) : null}
    </section>
  );
}
