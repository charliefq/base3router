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

## Queued

- A live Grokbot connection. It needs an API base URL, an owner-held
  credential that is not written into this repository, and a capability
  advertisement that names the target agent.
- An ActionGate tool plan for executable delegation. Until that exists, the
  chat gate stays `DENY`.
- Goal, redirect, acceptance, and brake linked to the V2 task contract.
- Tree usage identities beyond the thread, project, and principal already
  stored on the task.
- Mobile navigation, the command palette, and keybinding aliases.
- Enforced token, dollar, and clock pilot brakes. The real pilot stays
  prohibited.
