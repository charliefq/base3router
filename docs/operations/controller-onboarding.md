# External controller onboarding

In Agents, choose **Connect your agent**. Execution provider setup remains available there. Grok Bot is a supervisor/controller: its connection is separate from the CLI provider that executes coding work. Muse and dot remain unavailable until their adapters are implemented.

Choose requested projects and actions, then prepare a setup handoff. This is an in-memory draft, not an access grant. It contains no credentials or endpoint. No connection is attempted by preparing it. Closing the panel discards the draft.

## Live connection prerequisites

The server bridge is a separate integration dependency. Before enabling the panel's status/revoke/disconnect actions:

1. Reconcile the adapter v1 boundary in `packages/client-runtime/src/controllers/client.ts` with the server bridge's authoritative contracts. Supply an authenticated `ControllerTransport`; no generic RPC, shell, or filesystem passthrough belongs in it.
2. Bind `ControllerManagement` to the owner's authenticated environment administration transport and inject it into `ControllerConnect`. Its snapshot must identify the environment, controller, caller, actual grants, verification time, and supervised tasks. This build intentionally has no default management binding or guessed HTTP endpoint. Revoke/disconnect must complete on the server before acknowledging success. Disconnect removes the connection and invalidates access; neither action implies cancellation of existing runs.
3. The owner must select a persistent bridge host and an authenticated endpoint reachable from Grok Bot's computer. A local URL or private tailnet address is insufficient for the cloud bot. Do not expose the local server, change networking, or provision credentials as part of this frontend package.
4. The owner configures a separately scoped Grok Bot MCP caller with explicit project/action grants, using the bridge's supported authentication mechanism. Do not reuse provider-session credentials. Actual registration, credentials, hosting, and any associated budget need separate setup authorization.
5. Confirm MCP discovery and caller identity, grants, revocation, supervisor ownership and idempotency against the integrated bridge. Then, with explicit authorization for provider work, prove create → start → get → result → feedback/cancel on a bounded task. Fixture success does not prove a live connection.

Official references (read 2026-10-22): [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101) describes MCP support and the distinction between a supervisor and coding executors. The [Grok Bot changelog](https://x.ai/changelog/bot), October 11 entry, says private Tailscale MCP endpoints cannot yet be reached by the cloud bot. Its suggestion of Funnel is product guidance, not authorization to expose this installation.

## Adapter v1 integration boundary

The injected task transport accepts `{ version: 1, action, input }` and returns `{ version: 1, action, output }`. An MCP transport maps these six actions to bridge tools; this package does not claim these are xAI API endpoints. Caller identity comes from authenticated transport, not a request field.

- `create_task`: project/title/prompt plus an idempotency key → durable receipt and task snapshot, without claiming a run started.
- `start_task`: task and idempotency key → receipt, explicit `started`, nullable run ID. An accepted queue receipt is not a started run.
- `get_task`: task → state, project, supervisor and nullable run ID.
- `get_result`: task → explicit terminal flag, run ID and nullable result. Nonterminal results cannot be shown as completed output.
- `submit_feedback`: task, target run, feedback and idempotency key → accepted receipt, without claiming a revision ran.
- `cancel_task`: task and idempotency key → accepted receipt, without claiming execution already stopped.

The adapter validates response envelopes and does not automatically retry mutations after an uncertain transport failure. Reuse the same caller-owned idempotency key when the integrated bridge supports safe recovery. Authentication/denial/lease enforcement stays authoritative on the server. Responses must be reconciled with the sibling bridge before final integration; the frontend types are not a replacement for its wire schemas.

Web and desktop share this Agents panel. The reusable adapter has no DOM or browser transport dependency and can be used by mobile; native mobile onboarding is not added here. Local, remote, relay and tunnel deployments all need the same explicit management binding and reachable MCP endpoint. No URL or origin is baked into the client.
