# Codex cloud development

This checkout is based on PR #30 (`5f1a9f3e3ef2c43af5165ca3a657e792029e5431`), which includes the stacked Agents and Tasks work beyond `main`. Use the existing checkout; cloud tasks are already isolated and do not need another worktree.

Node 24.13.1 or newer is required. From any directory, run `bash /workspace/base3router/scripts/codex-cloud-setup.sh`. The script uses the repository's `pnpm@11.10.0` pin and frozen lockfile, and provides the local `vp` executable at `node_modules/.bin/vp`. It needs access to the package registry but no production credentials.

From `/workspace/base3router`, start the web and server development workflow with:

```sh
node_modules/.bin/vp run dev --home-dir /workspace/base3router/.t3/cloud-dev
```

Read the ports from the `[dev-runner]` line. Open the printed pairing URL for an authenticated local browser session; treat it as a credential. The isolated `.t3/cloud-dev` directory keeps this run away from any live user data. Do not set `VITE_HTTP_URL` or `VITE_WS_URL`. Live provider calls are not needed to inspect the chat shell, Agents, or Tasks.

Useful focused checks from the repository root:

```sh
node_modules/.bin/vp test run apps/server/src/collaboration/store.test.ts apps/server/src/collaboration/admit.test.ts apps/server/src/collaboration/decide.test.ts apps/server/src/policy/TaskPilotBrakes.test.ts apps/server/src/policy/TaskContract.test.ts apps/server/src/policy/TaskUsageAccounting.test.ts apps/web/src/components/chat/ThreadRelationshipsControl.agents.test.tsx apps/web/src/components/chat/agentSpawnSummary.test.ts
node_modules/.bin/vp run --filter t3 --filter @t3tools/web --concurrency-limit 2 typecheck
NODE_OPTIONS=--use-env-proxy node_modules/.bin/vp run --filter @t3tools/web build
```

The build's license plugin fetches SPDX notices from `raw.githubusercontent.com`. `NODE_OPTIONS=--use-env-proxy` lets Node use this cloud environment's HTTPS proxy. For follow-up work, reply in the same Codex thread; a GitHub PR comment has not been shown to wake a Codex task.
