# External controller onboarding

In Agents, choose **Connect your agent**. Execution provider setup remains available there. Grok Bot is a supervisor/controller, separate from the CLI provider executing coding work. Muse and dot remain unavailable until their adapters are implemented.

Connect uses the selected environment's existing authenticated owner session. Choose **Load controller identities**, explicitly select the owner-provisioned concrete ID belonging to Grok Bot, then check status. Identity names are not inferred to be product identities. The panel reads configured grants, expiry, generation and supervised tasks from the owner API. Neither registry configuration nor recent authenticated traffic proves that Grok Bot can connect: configured identities remain **live connection untested**.

Selection exists only in memory for this environment session. Closing setup forgets the panel selection and leaves existing grants intact. **Revoke controller access** revokes on the server; **Disconnect controller** performs the same revocation and forgets the selection only after acknowledgement. A denial or uncertain response keeps the selection and clears stale status evidence. Read status before retrying. Revocation does not cancel existing admitted work. There is no browser input, storage or fallback for controller bearer credentials.

The optional setup handoff contains requested project/action IDs and instructions, not a grant or credential. No endpoint registration, credential provisioning, grant creation, external bot contact or provider work occurs when preparing it.

## Live setup still required

1. The owner separately chooses and approves credential enrollment/rotation and binds an external controller identity to exact projects/actions. The bridge registry starts empty; this UI has no enrollment endpoint.
2. The owner selects a persistent authenticated endpoint reachable from the external product's computer. Grok Bot cloud cannot assume localhost or private-tailnet access. Endpoint/network changes require separate approval.
3. Configure Grok Bot's MCP client against `/api/controller/v1/mcp` with its separately provisioned credential, outside this browser. Owner environment session credentials authenticate only the administrative UI endpoints; they cannot authenticate the task tools.
4. After configuration, explicitly authorize and verify a bounded end-to-end lifecycle, including caller identity, grants, supervisor ownership, idempotency and revocation. Configuration/fixture success must not be reported as LIVE.

Official references: [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101) describes MCP support and supervision; the [October 11 Grok Bot changelog](https://x.ai/changelog/bot) notes that private Tailscale MCP servers are unreachable from the cloud bot. Product suggestions for exposure are not authorization to change this installation.

## Task adapter and recovery

The authoritative schemas and transport details are in [Controller bridge v1](controller-bridge-v1.md) and `packages/contracts/src/controllerBridge.ts`. The adapter validates those schemas directly. HTTP posts plain tool input and decodes `ControllerTaskView`; MCP `tools/call` uses `structuredContent`, not its text preview. It preserves receipt/admission/execution/terminal distinctions and exact fence, revision, run and attempt evidence. A durable accepted receipt does not establish provider execution.

- `create_task` requires the owner's reviewed model selection and full goal/redirect/acceptance/brake contract. It does not launch execution.
- `start_task` takes retained reviewed text and routing mode plus the current fence/revision from `get_task`. Bridge v1 supports only the first launch.
- `cancel_task` targets the exact current fence/revision/run/attempt. Admission of cancellation is not proof that interruption completed.
- `submit_feedback` records an explicit `helpful`/`not_helpful` rating using the current result's fingerprint/contextKey and exact run/attempt/fence/revision. A null feedback receipt is legitimate. It is not a correction prompt or another provider turn.
- For a **new prompt through bridge v1**, create a new task with a newly reviewed contract/model, then start its first run. Existing-task revision and continuation require a separately reviewed future bridge contract; do not send steering text as a rating.

For mutations, retain the result of `client.prepare(tool, reviewedInput)` before sending. Its `send()` captures a snapshot and reuses the exact payload/idempotency key on explicit recovery; it never retries automatically. Do not substitute changed intent or a new key after an uncertain outcome. `unauthorized`, `denied`, `stale`, `conflict`, and `unavailable` remain distinct bridge failures. Reads provide fresh progress; completed idempotency recovery can return the original saved view.

## Surfaces and scope

Web and desktop use the same connected Agents panel. Owner requests reuse the existing environment registry and cookie/bearer/DPoP session authentication, including request-bound relay proofs. Environment/session changes discard the old panel and ignore late responses. No origin is baked in. The reusable task adapter has no DOM dependency; native mobile onboarding is not added here.

Final browser verification and combined integration remain with the coordinator. This package does not deploy, provision credentials/grants, change networking, contact Grok Bot, or call a live provider.
