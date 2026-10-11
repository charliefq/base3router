# Chat agents

Base3Router is a chat-first coordination hub. It has its own embedded agents.
External agents such as Grokbot are contractors. Either side may converse
with and delegate to the other. Both sides share the task, the permission
decision, the evidence, and the returned result.

A model or CLI provider is not an employee. The Agents directory lists
registered identities. Grokbot is present as `NOT_CONNECTED` until an API base
URL, an owner-held credential, and a capability advertisement exist. None of
those are configured. A simulated transport is labeled on the message and is
not a live Grokbot connection.

The chat shell keeps its current navigation. Two primary entries sit on that
sidebar: Agents and Tasks. Routing, usage, settings, and approvals stay where
they already are.

## This slice

- Invalid execution-slot records fail closed. JSON `null`, scalars, malformed
  objects, and a `TERMINAL` record without observed evidence stay blocked.
- Collaboration commands are an event log in `collaboration_commands`. The
  fold admits one task per correlation, refuses a second send of the same
  command, and refuses an ambiguous name or a cross-project target.
- The coordination gate records `ALLOW` or `DENY`. A message always has
  `grantsExecution: false`. It does not start a provider.
- Scenarios A and B can be rehearsed on a simulated transport. Scenario C is
  the directory itself: open an agent and read that conversation.

## Queued

- Bind a collaboration task to an orchestration thread and open that thread
  in the existing thread route.
- Ask ActionGate before any real external send. This slice does not send one.
- Mobile navigation for the same two entries.
- Command palette and keybinding aliases.
- Enforced token, dollar, and clock pilot brakes. The real pilot stays
  prohibited.
