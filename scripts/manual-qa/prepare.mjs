import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
const kit = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = NodePath.resolve(process.argv[2] ?? process.cwd());
const base = NodePath.resolve(process.argv[3] ?? NodePath.join(repo, ".t3/qa-ac0-local"));
const expected = "ac0c3ace530744960abb9deeb7ca350a7e7c71cb";
if (
  NodeChildProcess.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== expected
)
  throw Error("Use exact accepted ac0c3ace checkout.");
if (
  NodeFS.existsSync(NodePath.join(repo, ".t3")) &&
  NodeFS.lstatSync(NodePath.join(repo, ".t3")).isSymbolicLink()
)
  throw Error("Do not use a symlinked state directory.");
if (!base.startsWith(NodePath.join(repo, ".t3/qa-")))
  throw Error("Only disposable repo/.t3/qa-* base directories are allowed.");
if (NodeFS.existsSync(base))
  throw Error("Base already exists: choose a fresh .t3/qa-* path; never overwrite state.");
if (!NodeFS.existsSync(NodePath.join(repo, "node_modules/.bin/vp")))
  throw Error("Install repository dependencies using its frozen lockfile first.");
NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true, mode: 0o700 });
NodeFS.mkdirSync(NodePath.join(base, "fake-codex-home"), { mode: 0o700 });
const peer = NodePath.join(base, "qa-provider.mjs");
NodeFS.copyFileSync(NodePath.join(kit, "qa-provider.mjs"), peer);
NodeFS.chmodSync(peer, 0o755);
const providers = Object.fromEntries(
  ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((k) => [
    k,
    { enabled: false },
  ]),
);
NodeFS.writeFileSync(
  NodePath.join(base, "userdata/settings.json"),
  JSON.stringify(
    {
      providers,
      providerInstances: {
        "qa-fixture": {
          driver: "codex",
          displayName: "QA fixture — no execution",
          enabled: true,
          config: {
            enabled: true,
            setupMode: "existing",
            binaryPath: peer,
            homePath: NodePath.join(base, "fake-codex-home"),
          },
        },
      },
      defaultModelSelection: { instanceId: "qa-fixture", model: "gpt-5.4" },
      automaticGitFetchInterval: 0,
    },
    null,
    2,
  ) + "\n",
);
NodeFS.writeFileSync(
  NodePath.join(base, "userdata/keybindings.json"),
  JSON.stringify([
    { key: "mod+alt+shift+a", command: "agents.open", when: "!terminalFocus && !previewFocus" },
    { key: "mod+alt+shift+t", command: "tasks.open", when: "!terminalFocus && !previewFocus" },
  ]) + "\n",
);
for (const slug of ["alpha", "beta"]) {
  const p = NodePath.join(base, "projects", slug);
  NodeFS.mkdirSync(p, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(p, "README.md"),
    "Disposable QA project. No remote, credentials, or execution scripts.\n",
  );
  NodeChildProcess.execFileSync("git", ["init", "-q", p]);
  NodeChildProcess.execFileSync("git", ["-C", p, "add", "README.md"]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    p,
    "-c",
    "user.name=QA fixture",
    "-c",
    "user.email=qa@example.invalid",
    "commit",
    "-q",
    "-m",
    "QA fixture",
  ]);
}
NodeFS.writeFileSync(
  NodePath.join(base, "qa-public.json"),
  JSON.stringify(
    {
      head: expected,
      purpose: "disposable manual QA; no UI pass claim",
      repo,
      base,
      defaultServerPort: 14473,
      defaultWebPort: 6433,
    },
    null,
    2,
  ),
);
const cache = NodePath.join(repo, "apps/server/node_modules/.cache/b3r-qa");
NodeFS.mkdirSync(cache, { recursive: true });
const seed = NodePath.join(cache, "seed.mjs");
NodeFS.copyFileSync(NodePath.join(kit, "seed.mjs"), seed);
NodeChildProcess.execFileSync(process.execPath, [seed, repo, base], {
  stdio: "inherit",
  env: process.env,
});
console.log("Prepared disposable candidate. No credentials included in this kit.");
