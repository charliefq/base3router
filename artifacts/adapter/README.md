# dot / Muse supervisor adapter

This integration artifact for a trusted external host reuses [the existing client](../../packages/client-runtime/src/controllers/client.ts) and [bridge contracts](../../packages/contracts/src/controllerBridge.ts). It adds no server, API, provider runtime, enrollment or UI. It is not a native dot plugin or a Muse directory submission. Both products remain **not connected / live untested**.

Use the [operating procedure](../../docs/operations/dot-muse-controller-adapters.md) for prerequisites and the full supervision loop.

## Host integration

Run inside the repository's TypeScript-capable external host with its normal workspace dependencies. These artifacts are intentionally outside the shipped application packages.

```ts
import { createSupervisor } from "./supervisor.ts";
import { controllerHttpTransport } from "./http.ts";

// Host integration sketch: these variables belong to the approved external host.
const supervisor = createSupervisor({
  binding: { product: "dot", identity: ownerSelectedIdentity },
  transport: controllerHttpTransport({
    origin: approvedHttpsOrigin,
    authorization: () => hostSecretStore.authorizationHeader(),
    fetch,
  }),
  now: () => Date.now(),
  savePending: (checkpoint) => privateJournal.replaceAtomically(checkpoint),
  // Omit restored when the journal is empty.
  restored: privateJournal.loadedCheckpoint,
});
```

For Muse, use a distinct owner-selected identity and `product: "muse"`. For an existing MCP client, replace `transport` with `{ protocol: "mcp", callTool: (name, input) => hostMcpClient.callTool(name, input) }`. Supply the actual `tools/call` result including `structuredContent`, not its text preview. MCP initialization/authentication and user approvals stay with that client. HTTP mode is for trusted external execution, not an owner-session browser.

The `.example.json` files use a **B3R handoff format**, not a vendor config schema. They request and grant nothing. They cannot be imported as a product plugin or used to claim installation. Resolve placeholders from separately approved setup; never substitute or commit a credential. The secret reference is only a host-local pointer.

`bindProducts(dotIdentity, museIdentity)` rejects a shared identity. Bindings contain safe owner metadata. The transport must authenticate as that same ID; response identity mismatches fail closed. Server registry ownership, project/action checks, revocation, expiry, governance and budget remain authoritative. Refresh local metadata from the owner boundary after changes with `updateIdentity`, never from edits to these examples.

## Journal contract

Supply one supervisor instance per concrete identity and a private durable journal. `savePending` must atomically commit the entire checkpoint before resolving; throwing must leave its old value intact. Use exclusive host ownership/CAS if multiple processes can open the journal. This adapter serializes writes in its instance. B3R provides durable fencing and idempotency across processes.

Checkpoints contain prompts, contracts, keys, identity/generation and target guards. Treat them as private task data; do not publish them, put them in templates/logs or store credentials there. Restore the saved object when restarting the same binding. Never edit it or regenerate its key. Do not automatically recover on startup.

After an uncertain transport result, incompatible reply, unavailable error or unknown admission/receipt without accepted admission, retain the checkpoint. Unknown execution remains visible but an accepted receipt settles delivery and clears its checkpoint. Reads may inspect progress but do not resolve that pending write. On explicit recovery authorization, call `recover()`; it resends precisely the saved action/input/key. A saved successful view may be old: read again for progress. Definitive denial/stale/conflict/invalid request clears the pending operation and propagates the error; stop that action. Revoked/expired grants or a changed generation cannot authorize recovery of an old checkpoint. Resolve that with the owner; do not mint a new key or swap credentials to bypass it.

## Focused verification

From repository root, using its configured Node/toolchain:

```sh
vp test run artifacts/adapter/supervisor.test.ts artifacts/adapter/http.test.ts
node_modules/.bin/tsc -p artifacts/adapter/tsconfig.json
vp lint artifacts/adapter/supervisor.ts artifacts/adapter/http.ts artifacts/adapter/supervisor.test.ts artifacts/adapter/http.test.ts
```

Fixtures use synthetic views and injected transports. They do not install a plugin, reach B3R, provision grants, request a provider or prove product connectivity.
