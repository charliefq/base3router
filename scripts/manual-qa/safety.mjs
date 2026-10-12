import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { DEFAULT_BASE_NAME } from "./candidate.mjs";

export function qaPaths(repoArgument, baseArgument) {
  const repo = NodeFS.realpathSync(repoArgument ?? process.cwd());
  const state = NodePath.join(repo, ".t3");
  const base = NodePath.resolve(baseArgument ?? NodePath.join(state, DEFAULT_BASE_NAME));
  if (
    NodePath.dirname(base) !== state ||
    !/^qa-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(NodePath.basename(base))
  )
    throw Error("Use a direct disposable repo/.t3/qa-* child.");
  for (const path of [state, base])
    if (NodeFS.existsSync(path) && NodeFS.lstatSync(path).isSymbolicLink())
      throw Error("Do not use symlinked QA state.");
  return { repo, base };
}

export function qaEnvironment(repo, base, inherited = process.env) {
  // Do not read local configuration or attempt to override its secret values.
  for (const directory of [
    repo,
    NodePath.join(repo, "apps/web"),
    NodePath.join(repo, "apps/server"),
  ])
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local"])
      if (NodeFS.existsSync(NodePath.join(directory, name)))
        throw Error("QA requires a candidate without development env files; no values read.");
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(T3CODE_|T3_FAKE_|VITE_|EXPO_PUBLIC_|OTEL_|CLERK_)/.test(key) &&
        !["HOST", "PORT", "NODE_OPTIONS"].includes(key),
    ),
  );
  return {
    ...env,
    PATH: NodePath.join(repo, "node_modules/.bin") + NodePath.delimiter + (env.PATH ?? ""),
    T3CODE_HOST: "127.0.0.1",
    T3CODE_TAILSCALE_SERVE: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_PORT_OFFSET: "700",
    T3_FAKE_CODEX_LOG: NodePath.join(base, "fake-peer.jsonl"),
  };
}

export function validateFixture(base, trustedPeer, restoreNormalizedDefaults = false) {
  for (const name of [
    "",
    "userdata",
    "fake-codex-home",
    "userdata/settings.json",
    "qa-owned-process.json",
    "private-startup.log",
  ])
    if (
      NodeFS.existsSync(NodePath.join(base, name)) &&
      NodeFS.lstatSync(NodePath.join(base, name)).isSymbolicLink()
    )
      throw Error("Do not use symlinked QA files.");
  const settings = JSON.parse(
    NodeFS.readFileSync(NodePath.join(base, "userdata/settings.json"), "utf8"),
  );
  const allowedSettings = new Set([
    "providers",
    "providerInstances",
    "defaultModelSelection",
    "automaticGitFetchInterval",
    "projectSettingsOverrides",
    "projectSettingsFolded",
  ]);
  if (
    Object.keys(settings).some((key) => !allowedSettings.has(key)) ||
    settings.automaticGitFetchInterval !== 0
  )
    throw Error("Unexpected QA settings; refusing external configuration.");
  const names = ["antigravity", "claudeAgent", "codex", "cursor", "grok", "opencode", "pi"];
  const exactKeys = (value, keys) =>
    value &&
    typeof value === "object" &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const providerNames = restoreNormalizedDefaults
    ? names.filter(
        (key) => !["pi", "antigravity"].includes(key) || key in (settings.providers ?? {}),
      )
    : names;
  if (
    !exactKeys(settings.providers, providerNames) ||
    providerNames.some(
      (key) =>
        !exactKeys(settings.providers[key], ["enabled"]) ||
        settings.providers[key].enabled !== false,
    )
  )
    throw Error("Real providers must be complete and disabled.");
  const instance = settings.providerInstances?.["qa-fixture"];
  const peer = NodePath.join(base, "qa-provider.mjs");
  if (
    !exactKeys(settings.providerInstances, ["qa-fixture"]) ||
    !exactKeys(instance, ["driver", "displayName", "enabled", "config"]) ||
    instance.driver !== "codex" ||
    instance.enabled !== true ||
    instance.displayName !== "QA fixture — no execution" ||
    !exactKeys(
      instance.config,
      restoreNormalizedDefaults && !("enabled" in instance.config)
        ? ["setupMode", "binaryPath", "homePath"]
        : ["enabled", "setupMode", "binaryPath", "homePath"],
    ) ||
    (instance.config.enabled !== true &&
      !(restoreNormalizedDefaults && !("enabled" in instance.config))) ||
    instance.config.setupMode !== "existing" ||
    instance.config.binaryPath !== peer ||
    instance.config.homePath !== NodePath.join(base, "fake-codex-home")
  )
    throw Error("QA fixture configuration drift; refusing startup.");
  if (!NodeFS.lstatSync(peer).isFile() || NodeFS.lstatSync(peer).isSymbolicLink())
    throw Error("QA peer must be a regular trusted file.");
  const hash = (path) =>
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
  if (hash(peer) !== hash(trustedPeer)) throw Error("QA peer content drift; refusing startup.");
  if (restoreNormalizedDefaults) {
    for (const key of names) settings.providers[key] = { enabled: false };
    instance.config.enabled = true;
    NodeFS.writeFileSync(
      NodePath.join(base, "userdata/settings.json"),
      JSON.stringify(settings, null, 2) + "\n",
    );
  }
}

export function hasLiveOwnership(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw Error("Invalid QA ownership record.");
  const processes = NodeChildProcess.execFileSync("ps", ["-eo", "pid=,pgid=,stat="], {
    encoding: "utf8",
  });
  return processes
    .trim()
    .split("\n")
    .some((line) => {
      const [processId, groupId, state] = line.trim().split(/\s+/);
      return (Number(processId) === pid || Number(groupId) === pid) && !state.startsWith("Z");
    });
}
