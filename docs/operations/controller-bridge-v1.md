# External controller bridge v1

The bridge is an external **supervisor** of B3R tasks. Configured provider instances remain the executors. Grok Bot, Muse, and dot do not become provider instances through this API. The internal provider-session `/mcp` endpoint and its bearer registry are unchanged; their credentials cannot authenticate here.

## Transport and authentication

- `POST /api/controller/v1/tools/{name}`: JSON input from `ControllerToolInputs` in `packages/contracts/src/controllerBridge.ts`; JSON output is `ControllerTaskView`.
- `POST /api/controller/v1/mcp`: stateless Streamable HTTP JSON responses, protocol `2025-06-18`; supports `initialize`, `ping`, `tools/list`, `tools/call`, and `notifications/initialized`. No SSE stream, generic RPC, shell, files, resources, or prompts. `tools/call` takes `{name, arguments}` and returns the same view as text and `structuredContent`.
- Both require `Authorization: Bearer <separately-provisioned-controller-credential>`. There is no cookie, provider-session, or environment access-token fallback. Bodies are limited to 64 KiB; unknown input fields are rejected.
- Identities use the durable `controller_identities` registry: ID, display name, SHA-256 of the credential, exact project IDs and action names, generation, UTC expiration, and revocation time. Credentials must use the `b3rc_` namespace and be 32–512 characters. This implementation does **not** generate, configure, import, or expose credentials, nor offer an enrollment endpoint. The production registry starts empty. Fixtures use clearly synthetic credentials only.

## Tool inputs

All selectors and keys are opaque strings. `taskId` is the bridge-issued ID, not a caller-selected thread. Creation has no side effect on providers.

| Tool              | JSON input                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_task`     | `idempotencyKey`, `projectId`, `title`, `modelSelection:{instanceId,model}`, `contract:{goal,redirect,acceptance,brake:{maxProviderStarts,stopConditions,maxTokens?,maxCostUsd?,deadlineAt?}}` |
| `start_task`      | `taskId`, `idempotencyKey`, `expectedFence`, `expectedRevision`, `text`, `routingMode:"manual"\|"auto"`                                                                                        |
| `get_task`        | `taskId`                                                                                                                                                                                       |
| `get_result`      | `taskId`                                                                                                                                                                                       |
| `submit_feedback` | `taskId`, `idempotencyKey`, `expectedFence`, `expectedRevision`, `runId`, `attemptId`, `fingerprint`, `contextKey`, `kind:"helpful"\|"not_helpful"`, `confirm:true`                            |
| `cancel_task`     | `taskId`, `idempotencyKey`, `expectedFence`, `expectedRevision`, `runId`, `attemptId`                                                                                                          |

Creation reuses reviewed governed creation; launch reuses the existing first-launch review, execution grants, budget, and ActionGate checks. Runtime is approval-required/default. Arbitrary provider options, paths, attachments, and runtime overrides are not accepted. The first launch is the only launch supported by v1; result feedback records an evaluation and does not start a revision run. Revision/continuation requires a separately reviewed future contract.

Read `get_task` before a new mutation. Copy its `fence`, `contractRevision`, and exact `run` target. For feedback, also copy `feedback.fingerprint` and `feedback.contextKey` only when `feedback.status === "available"`. They bind the current result, revision, caller session generation, and existing feedback policy. Free-text steering is not a feedback operation.

`cancel_task` requests interruption of the exact active run/attempt and holds the queue. It checks revision and attempt again atomically inside orchestration. It rejects queued, already terminal, changed, or superseded targets; a successful request does not mean native cancellation has completed. Poll `get_task` for terminal evidence.

## Response and recovery

Every success is a `ControllerTaskView` with `version:1`, `controllerId`, `taskId`, `threadId`, `projectId`, `fence`, `contractRevision`, `admission`, `execution`, `terminal`, `run`, `result`, `feedback`, and `receipt`.

- `receipt.status:"accepted"` means the orchestration command was durably admitted. It does not establish a provider start or success.
- `admission:"admitted"` is correlated first-launch evidence. `execution:"observed"` requires persisted provider execution evidence. `run.status` reports the durable run; `terminal` does not imply successful output.
- `result` is the existing bounded, correlated task-result readout (plain text preview/failure or an explicit unavailable reason). No file retrieval is provided. `get_result` omits feedback.
- Reuse the **same key and exact input** to recover an uncertain request. Inputs are canonically hashed; keys are scoped to the identity across tools. Changed input/tool with the same key returns `conflict`. Completed retries return the original saved view; use a read tool for fresh progress.
- Durable exclusive supervisor ownership prevents cross-controller access. Every new task mutation advances a monotonic fence and claims a persisted pending operation. No timeout-based takeover can race an old writer. A crash resumes only its exact stored command ID; internal orchestration deduplication prevents another provider start. Unknown admission retains the pending claim rather than inventing a retry. Revocation/expiry prevents recovery by the old credential.
- HTTP errors are `{version:1,error}`: `unauthorized` (401), `denied` (403), `invalid_request` (400), `stale`/`conflict` (409), `unavailable` (503). MCP tool failures return `isError:true` with that JSON as text. Audit rows record identity, action, task, outcome, and time; never credentials or prompt/result text.

## Owner-session administration and PR94 reconciliation

The production UI must use its existing authenticated **owner environment session**, never a controller bearer stored in a browser:

- `GET /api/controller/v1/identities`, `access:read`: safe identity metadata, exact grants, expiry/revocation, generation, supervised-task count. No credential hash.
- `POST /api/controller/v1/status` with `{controllerId}`, `access:read`: `ControllerStatus` with environment ID, identity, configuration (`not_configured`, `configured`, `revoked`, `expired`), last authenticated controller traffic, and bounded supervised task views. Feedback authority is omitted. Registry configuration/recent traffic alone does not prove Grok Bot connectivity.
- `POST /api/controller/v1/revoke` with `{controllerId}`, `access:write`: revoke and increment generation. Existing admitted work is not automatically cancelled; revocation immediately denies further controller reads/writes. UI disconnect can forget its binding after revocation; it must not silently leave a live grant behind.

PR94 (`caa3e5a1ee31968d74c1cb0a59e491c9330f50ca`) intentionally exported a provisional client contract. Final integration must replace its `ControllerInputs/Outputs` with these shared schemas or an explicit mapping; forwarding its old inputs is insufficient:

1. `create_task.prompt` becomes `start_task.text`; the owner must supply/review model and full task contract before creation. Do not invent missing governance fields.
2. Start must include the latest fence/revision and the retained reviewed text/routing choice. `started` may be true only with `execution:"observed"`, never from receipt/admission alone.
3. Feedback must collect an explicit helpful/not-helpful decision and exact current result fingerprint/session/attempt. Old arbitrary `feedback:string` cannot be mapped to an execution or review decision.
4. Cancel must include exact current fence/revision/run/attempt; never fill these from stale UI state or remove the guards.
5. Its `{version,action,output}` envelope is a client adapter concern: this HTTP API returns the view directly; MCP returns it in `structuredContent`. `receiptId` maps to `receipt.commandId` when present; task supervisor maps to `controllerId`; run maps to `run.runId`. A null receipt is legitimate for reads and feedback.
6. Map task state conservatively: no run = created; active/preparing/starting = running only when observed, otherwise waiting; interrupted/cancelled = cancelled; failed = failed; completed = completed. Preserve admission, attempt, revision, and fence alongside the older display type.
7. `ControllerManagement.read(kind)` resolves a previously owner-bound concrete identity ID, calls status, and maps grants/tasks. Missing identity = `needs_setup`; revoked/expired = revoked/unavailable. Do not infer `verified_connected` solely from configured registry state. No automatic credential setup. `revoke(kind)` uses the owner session endpoint above.

No frontend files from PR94 or dependency PR91/92 are changed here. The final coordinator owns their integration.

## Real setup still required

The owner must separately choose and approve credential enrollment/rotation, bind each concrete controller identity to exact projects/actions, and configure the external product's MCP client against a reachable authenticated endpoint. Grok Bot cloud cannot assume localhost/private-tailnet access. This PR changes no network/security settings, provisions no credentials, buys no hosting, and makes no paid provider request. A live endpoint and authorized live lifecycle test remain separate setup/integration steps.
