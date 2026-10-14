# Chat agents

Base3Router is a chat-first coordination hub. Internal agents are configured
providers. External agents such as Grokbot are contractors. A provider CLI is
not an employee, and a simulated transport is not a live contractor.

The chat shell keeps its current navigation. Agents and Tasks are the two
added entries. Routing, usage, settings, and approvals stay where they already
are.

## This slice

Agents reads the projects and providers of the primary environment. One
project is used when it is the only one. More than one project waits for an
explicit choice. A ready provider opens or reuses a persisted orchestration
thread in that project and the existing composer. Tasks returns to that same
thread. Grokbot stays `NOT_CONNECTED` and does not open a chat.

A ready internal provider also offers **New task** for the selected project.
Supply a title, Goal, Redirect, Acceptance and an explicit provider-start limit
and stop conditions. Token, reported-cost and UTC deadline bounds are optional;
omitting them does not mean unlimited budget. Review the complete contract and
environment/project/provider/model before confirming. Creation records one
distinct owned task with revision 1 and approval-required permissions; it sends
no message, starts no provider work and grants no execution. Open its confirmed
conversation or find the same task in Tasks. Pausing, revising instructions and
resuming remain separate decisions.

For an owned active, unaccepted governed task with no messages or runs, **Prepare first instructions** reviews current task facts and the full contract, then fills only an empty local composer draft on explicit confirmation. Existing text, attachments, contexts and queued edits are preserved. This is preparation from observed reads, not an atomic server execution guarantee. Open the existing conversation, edit, choose the existing Manual/Auto option and press Send separately; preparation grants no execution or acceptance.

Auto preview reads existing policy and outcome evidence without initializing defaults or persisting proposed text. It shares the dispatch calculation, but its result is only a snapshot: dispatch recalculates from current facts and separately enforces governed admission. Missing policy data uses an explicit ephemeral V0; unavailable ownership or task facts never become a fallback. Local task classification is deterministic and is not an LLM interpretation.

Revision-request preparation uses the existing owned-task review and validated completed result readout. Repeated collaboration and projection reads bind the review to the exact latest run, message, attempt, turn and item; a same-item change beyond a truncated excerpt also retires it. This is observed coherence, not atomic execution authorization. Only user-written requested changes enter an empty local draft; the result is context, not outgoing text or an acceptance judgment. Send still uses the existing admission path.

If a response is lost, **Recover task creation** reads the original identity;
it does not resend creation or allocate another task. An unresolved attempt is
retained in this browser session across navigation and reload. Return to its
original environment and project to reconcile. A fresh authenticated receipt read can confirm the owned committed task or
prove rejection of a future reviewed attempt. Only after that proof may you
separately choose New task, review and confirm a new draft. A rejected attempt
does not mean its thread is empty. Missing or legacy unbound receipts remain
unknown and block creation; cached outcomes must be revalidated after reload or
context changes.

The HTTP command is sealed with the authenticated principal. Client `actor`
and `fromAgentId` are discarded. The project must exist, and a thread bind
must name a thread already stored in that project. The provider identity is
copied from the configured provider, and a provider that is not ready is
refused.

`thread.bind` records a blocked task with gate `DENY`. Opening a thread does
not start a provider turn. Executable delegation uses the same gate.
`ActionGate.authorizeTool` plans MCP tools, so a chat command does not call it
with a made-up tool name. The production gate stays `DENY`, and a denied task
cannot become running because a message was stored.

Clarification ids include the command id. The task keeps one
`pendingClarificationId`. A reply must cite that id, the clarification kind,
the assignee and owner, and the task's current revision. An older question, a
delegation id, or a different principal does not resume the task. Repeating a
command id does not create a second message.

`scenario.rehearse`, `transport.simulate`, and client `agent.register` are
rejected and are not stored. Deterministic cases live in the collaboration
tests.

## Offline pilot brakes

A governed contract can name `maxTokens`, `maxCostUsd`, and an absolute
`deadlineAt`. Those values are explicit. Before any bound is frozen, omitting
them leaves the start-count brake in place and does not mean the budget is
unlimited. The first deadline and the caps are stored on the task tree. A
later payload may lower a cap. It cannot move the deadline forward, and
omitting the fields does not clear a bound that was already stored. Token and
dollar totals include the root, children, retries, and handoffs.

Unknown usage, or a price that is missing or unverified, denies the next
start. Production usage rows stay unverified. The only verified price is a
fixture row labeled `synthetic-fixture`. A usage update that reaches a frozen
cap, and database startup when a frozen deadline is already past, request
interrupt for an occupied lease. That does not require another admission.
There is no timer: a silent turn is noticed on the next usage update or the
next time the database opens. The lease stays until an explicit completed or
aborted confirmation. An interrupt request is not that confirmation, and an
unknown stream end is not one either.

One provider turn can report more usage than the budget that remained when it
started. This server does not send the provider a remaining-token or dollar
ceiling, so the offline path cannot promise a hard mid-turn stop. The
recorded total is the reported total, and the next start is refused once the
frozen bound is spent. Collaboration execution stays `DENY`, and Grokbot stays
`NOT_CONNECTED`.

## Queued

- A live provider composer. This sandbox has no executable provider, so Agents
  did not open a new thread.
- A live Grokbot connection. It needs an API base URL, an owner-held
  credential that is not written into this repository, and a capability
  advertisement that names the target agent.
- Provider ids are interim. They are not an independent named employee identity.
- Per-principal project authorization, before any external or multi-principal
  ingress.
- Thread binding recovery across page reloads and tabs; real-browser validation
  of the mounted-page project selection and repeat-click guards.
- An ActionGate tool plan for executable delegation. Until that exists, the
  chat gate stays `DENY`.
- Mobile creation/binding recovery and keybinding aliases; native Device validation
  of the read-only collaboration entry.
- A provider remaining-budget ceiling. One offline turn can report past the
  frozen cap. The next start is refused after that report. Spend remains
  unknown, and a real paid pilot is not authorized.
