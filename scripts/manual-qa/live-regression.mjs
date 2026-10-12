import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeHttp from "node:http";
const kit = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repo = process.env.B3R_QA_REPO;
NodeTest.test(
  "actual hostile env, duplicate preservation, omitted-base stop and restart",
  { skip: !repo, timeout: 120000 },
  async () => {
    const base = NodePath.join(NodeFS.realpathSync(repo), ".t3/qa-ac0-local");
    NodeAssert.equal(
      NodeFS.existsSync(base),
      false,
      "Default fixture must be absent; never overwrite state.",
    );
    const run = (name, args = []) =>
      NodeChildProcess.execFileSync(process.execPath, [NodePath.join(kit, name), repo, ...args], {
        stdio: "pipe",
        timeout: 30000,
      });
    run("prepare.mjs");
    let hits = 0;
    const sentinel = NodeHttp.createServer((_req, res) => {
      hits++;
      res.end("QA-NONSECRET");
    });
    await new Promise((resolve) => sentinel.listen(0, "127.0.0.1", resolve));
    const external = `http://127.0.0.1:${sentinel.address().port}`;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const launch = (host) =>
      NodeChildProcess.spawn(process.execPath, [NodePath.join(kit, "start.mjs"), repo], {
        stdio: "ignore",
        env: {
          ...process.env,
          T3CODE_HOST: host,
          T3CODE_TAILSCALE_SERVE: "true",
          T3CODE_RELAY_URL: external,
          VITE_T3CODE_RELAY_URL: external,
          T3CODE_OTLP_TRACES_URL: external,
          T3CODE_OTLP_METRICS_URL: external,
          T3CODE_OTLP_LOGS_URL: external,
          T3CODE_OTLP_HEADERS: "QA-NONSECRET",
          OTEL_EXPORTER_OTLP_ENDPOINT: external,
          VITE_RELAY_OTLP_TRACES_URL: external,
          VITE_RELAY_OTLP_TRACES_TOKEN: "QA-NONSECRET",
        },
      });
    const waitHealthy = async () => {
      for (let attempt = 0; attempt < 90; attempt++) {
        try {
          const response = await fetch("http://127.0.0.1:14473/api/auth/session", {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return;
        } catch {}
        await wait(500);
      }
      throw Error("QA backend did not become healthy; inspect private log locally.");
    };
    const stop = async () => {
      run("start.mjs", ["--stop"]); // no base argument: actual regression
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          await fetch("http://127.0.0.1:14473/api/auth/session", {
            signal: AbortSignal.timeout(2000),
          });
        } catch {
          return;
        }
        await wait(250);
      }
      throw Error("QA backend remained live after recorded-group stop.");
    };
    try {
      for (const host of ["0.0.0.0", "::"]) {
        const launcher = launch(host);
        await waitHealthy();
        console.log("QA hostile-host startup healthy: " + host);
        const pid = JSON.parse(
          NodeFS.readFileSync(NodePath.join(base, "qa-owned-process.json"), "utf8"),
        ).pid;
        if (NodeProcess.platform === "linux") {
          const env = NodeFS.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
          NodeAssert.ok(env.includes("T3CODE_HOST=127.0.0.1"));
          NodeAssert.ok(env.includes("T3CODE_TAILSCALE_SERVE=false"));
          NodeAssert.equal(
            env.some((e) => /^(T3CODE_RELAY_URL|T3CODE_OTLP_|OTEL_EXPORTER_|VITE_RELAY_)/.test(e)),
            false,
          );
          const sockets = NodeChildProcess.execFileSync("ss", ["-ltn"], { encoding: "utf8" });
          NodeAssert.ok(sockets.includes("127.0.0.1:14473"));
          NodeAssert.equal(/(?:0\.0\.0\.0|\[::\]):14473/.test(sockets), false);
        }
        const files = ["private-startup.log", "qa-owned-process.json"].map((name) =>
          NodePath.join(base, name),
        );
        const hash = (file) =>
          NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
        const before = files.map(hash);
        NodeAssert.throws(() => run("start.mjs"));
        files.forEach((file, index) => NodeAssert.equal(hash(file), before[index]));
        NodeAssert.equal(hits, 0, "No ambient relay/OTLP requests");
        await stop();
        await new Promise((resolve) => {
          if (launcher.exitCode !== null || launcher.signalCode !== null) resolve();
          else launcher.once("exit", resolve);
        });
        run("prepare.mjs", [base, "--restore-settings"]);
        console.log("QA duplicate preserved; omitted-base stop and restoration passed.");
      }
    } finally {
      try {
        await stop();
      } catch {}
      sentinel.closeAllConnections();
      await new Promise((resolve) => sentinel.close(resolve));
    }
    // Keep disposable state for local inspection. No secrets printed or exported.
  },
);
