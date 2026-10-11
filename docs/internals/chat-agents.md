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
`deadlineAt`. Those values are explicit. Omitting them leaves the start-count
brake in place and does not mean the budget is unlimited. The deadline is
frozen before the first budgeted start and a later contract revision does not
move it forward. Token and dollar totals include the root, children, retries,
and handoffs.

Unknown usage, or a price that is missing or unverified, denies the next
start. Production usage rows stay unverified. The only verified price is a
fixture row labeled `synthetic-fixture`. Exhaustion or a passed deadline
refuses a new admission and asks active work to stop. The lease stays until
an explicit completed or aborted confirmation. An interrupt request is not
that confirmation. Collaboration execution stays `DENY`, and Grokbot stays
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
- Repeated clicks and project selection for thread binding.
- An ActionGate tool plan for executable delegation. Until that exists, the
  chat gate stays `DENY`.
- Mobile navigation, the command palette, and keybinding aliases.
- A real paid pilot. Token, dollar, and clock sentences are enforced only for
  an explicit offline contract. Spend remains unknown.
