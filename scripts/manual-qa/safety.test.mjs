import { test, afterAll } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { qaPaths, qaEnvironment, validateFixture, hasLiveOwnership } from "./safety.mjs";
const kit = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "b3r-qa-safety-"));
const repo = NodePath.join(tmp, "repo");
const base = NodePath.join(repo, ".t3/qa-test");
NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(base, "fake-codex-home"));
const peer = NodePath.join(base, "qa-provider.mjs");
const trusted = NodePath.join(kit, "qa-provider.mjs");
NodeFS.copyFileSync(trusted, peer);
const settingsPath = NodePath.join(base, "userdata/settings.json");
const fixture = () => ({
  providers: Object.fromEntries(
    ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((key) => [
      key,
      { enabled: false },
    ]),
  ),
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
  automaticGitFetchInterval: 0,
});
const write = (settings) => NodeFS.writeFileSync(settingsPath, JSON.stringify(settings));

test("single direct canonical child; nested external symlink rejected before writes", () => {
  NodeAssert.deepEqual(qaPaths(repo, base), { repo, base });
  const external = NodePath.join(tmp, "external");
  NodeFS.mkdirSync(external);
  NodeFS.symlinkSync(external, NodePath.join(repo, ".t3/qa-parent"));
  NodeAssert.throws(() => qaPaths(repo, NodePath.join(repo, ".t3/qa-parent/child")));
  NodeAssert.deepEqual(NodeFS.readdirSync(external), []);
  NodeFS.symlinkSync(external, NodePath.join(repo, ".t3/qa-link"));
  NodeAssert.throws(() => qaPaths(repo, NodePath.join(repo, ".t3/qa-link")));
});
test("QA child strips product/telemetry config and preserves platform guards", () => {
  const env = qaEnvironment(repo, base, {
    T3CODE_HOST: "::",
    T3CODE_TAILSCALE_SERVE: "true",
    T3CODE_RELAY_URL: "https://invalid.example",
    T3CODE_OTLP_TRACES_URL: "http://127.0.0.1:1",
    T3CODE_OTLP_HEADERS: "QA-NONSECRET",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    VITE_RELAY_OTLP_TRACES_TOKEN: "QA-NONSECRET",
    HTTPS_PROXY: "platform-proxy",
    NODE_EXTRA_CA_CERTS: "platform-ca",
    PLATFORM_AUTH_GUARD: "guard",
    HOME: "original-home",
  });
  NodeAssert.equal(env.T3CODE_HOST, "127.0.0.1");
  NodeAssert.equal(env.T3CODE_TAILSCALE_SERVE, "false");
  for (const key of [
    "T3CODE_RELAY_URL",
    "T3CODE_OTLP_TRACES_URL",
    "T3CODE_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "VITE_RELAY_OTLP_TRACES_TOKEN",
  ])
    NodeAssert.equal(env[key], undefined);
  NodeAssert.equal(env.HTTPS_PROXY, "platform-proxy");
  NodeAssert.equal(env.NODE_EXTRA_CA_CERTS, "platform-ca");
  NodeAssert.equal(env.PLATFORM_AUTH_GUARD, "guard");
  NodeAssert.equal(env.HOME, "original-home");
  NodeFS.mkdirSync(NodePath.join(repo, "apps/web"), { recursive: true });
  for (const name of [".env", ".env.local", "apps/web/.env.development.local"]) {
    NodeFS.writeFileSync(NodePath.join(repo, name), "QA-NONSECRET");
    NodeAssert.throws(() => qaEnvironment(repo, base));
    NodeFS.unlinkSync(NodePath.join(repo, name));
  }
});
test("complete disabled providers and exact fixture content; drift fails closed", () => {
  write(fixture());
  validateFixture(base, trusted);
  const mutations = [
    (s) => delete s.providers,
    (s) => delete s.providers.codex,
    (s) => (s.providers.codex.enabled = true),
    (s) => (s.providerInstances["other"] = {}),
    (s) => (s.providerInstances["qa-fixture"].driver = "grok"),
    (s) => delete s.providerInstances["qa-fixture"].config.enabled,
    (s) => (s.providerInstances["qa-fixture"].config.binaryPath = "real-provider"),
    (s) => (s.providerInstances["qa-fixture"].config.homePath = "real-home"),
    (s) => (s.providerInstances["qa-fixture"].config.launchArgs = ["unsafe"]),
    (s) => (s.observability = { otlpTracesUrl: "https://invalid.example" }),
  ];
  for (const mutate of mutations) {
    const s = fixture();
    mutate(s);
    write(s);
    NodeAssert.throws(() => validateFixture(base, trusted));
  }
  write(fixture());
  NodeFS.appendFileSync(peer, "\n// drift");
  NodeAssert.throws(() => validateFixture(base, trusted));
  NodeFS.copyFileSync(trusted, peer);
  NodeFS.unlinkSync(peer);
  NodeFS.symlinkSync(trusted, peer);
  NodeAssert.throws(() => validateFixture(base, trusted));
  NodeFS.unlinkSync(peer);
  NodeFS.copyFileSync(trusted, peer);
});
test("explicit restoration accepts only known serialized defaults", () => {
  const s = fixture();
  delete s.providers.pi;
  delete s.providers.antigravity;
  delete s.providerInstances["qa-fixture"].config.enabled;
  write(s);
  NodeAssert.throws(() => validateFixture(base, trusted));
  validateFixture(base, trusted, true);
  validateFixture(base, trusted);
  delete s.providers.codex;
  write(s);
  NodeAssert.throws(() => validateFixture(base, trusted, true));
});
test("live ownership detected without killing processes", () => {
  NodeAssert.equal(hasLiveOwnership(process.pid), true);
  NodeAssert.throws(() => hasLiveOwnership(1));
});
afterAll(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
