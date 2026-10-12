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
- Mobile navigation and keybinding aliases.
- A provider remaining-budget ceiling. One offline turn can report past the
  frozen cap. The next start is refused after that report. Spend remains
  unknown, and a real paid pilot is not authorized.
