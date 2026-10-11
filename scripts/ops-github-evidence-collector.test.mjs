import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { assert, describe, it } from "vite-plus/test";
import shape from "./testFixtures/ops-github-evidence.json";
import { collectGitHubEvidence } from "./ops-github-evidence-collector.mjs";

const hash = (body) => NodeCrypto.createHash("sha256").update(body).digest("hex");
const logFixture = NodeFS.readFileSync(
  new URL("./testFixtures/ops-checkout.txt", import.meta.url),
  "utf8",
);
const root = `/repos/${shape.repository}`;
const paths = {
  pr: `${root}/pulls/12`,
  comments: `${root}/issues/12/comments`,
  run: `${root}/actions/runs/80`,
  aggregateJob: `${root}/actions/jobs/82`,
  aggregateCheck: `${root}/check-runs/81`,
  testJob: `${root}/actions/jobs/83`,
  testCheck: `${root}/check-runs/84`,
  logs: `${root}/actions/jobs/83/logs`,
  merge: `${root}/git/commits/${shape.mergeCommit.sha}`,
};
const observedAt = "2026-01-02T12:00:00Z";

function fixture() {
  const raw = structuredClone(shape);
  raw.pr.base.repo.id = raw.pr.head.repo.id = 123;
  raw.run.repository.full_name = shape.repository;
  raw.comment.updated_at = raw.comment.created_at;
  const job = {
    ...raw.job,
    head_sha: raw.pr.head.sha,
    head_branch: raw.pr.head.ref,
    run_url: `https://api.github.com${root}/actions/runs/80`,
    steps: [{ name: "Require every job to pass" }],
  };
  const testJob = {
    ...job,
    id: 83,
    name: "Test",
    check_run_url: `https://api.github.com${root}/check-runs/84`,
    steps: [
      {
        name: "Checkout",
        status: "completed",
        conclusion: "success",
        started_at: "2026-01-01T10:00:00Z",
        completed_at: "2026-01-01T10:00:07Z",
      },
    ],
  };
  const responses = new Map(
    Object.entries({
      [paths.pr]: raw.pr,
      [paths.comments]: [raw.comment],
      [paths.run]: raw.run,
      [paths.aggregateJob]: job,
      [paths.aggregateCheck]: raw.check,
      [paths.testJob]: testJob,
      [paths.testCheck]: { ...raw.check, id: 84, name: "Test" },
      [paths.logs]: logFixture,
      [paths.merge]: raw.mergeCommit,
    }).map(([path, data]) => [path, { status: 200, headers: {}, complete: true, data }]),
  );
  const input = {
    repository: shape.repository,
    repositoryId: 123,
    prNumber: 12,
    expectedHead: raw.pr.head.sha,
    expectedBase: raw.pr.base.sha,
    runId: 80,
    attempt: 2,
    requiredWorkflow: { id: 7, path: ".github/workflows/ci.yml", name: "CI" },
    requiredCheck: { id: 81, jobId: 82, appId: 99, name: "Check" },
    actualTestJobId: 83,
    comments: [{ id: 44, authorId: 91, bodyDigest: hash(raw.comment.body) }],
  };
  const calls = [];
  const transport = async (request) => {
    calls.push(structuredClone(request));
    assert.equal(request.method, "GET");
    assert.ok(request.path.startsWith(`${root}/`));
    assert.ok(!/contents|review|dispatch|start/.test(request.path));
    return structuredClone(responses.get(request.path) ?? { status: 404 });
  };
  return {
    responses,
    input,
    calls,
    raw: (path) => responses.get(path).data,
    run: (options = {}) =>
      collectGitHubEvidence({ input, readTransport: transport, now: () => observedAt, ...options }),
    transport,
  };
}

function noExecution(bundle) {
  assert.notEqual(bundle.status, "verified");
  for (const key of ["acceptance", "intent", "write", "start", "dispatch", "reviewReceipt"])
    assert.equal(Object.hasOwn(bundle, key), false);
}

describe("read-only GitHub evidence collector", () => {
  it.each(["head", "test-merge"])(
    "binds %s checkout separately from aggregate Check",
    async (mode) => {
      const f = fixture();
      if (mode === "head") {
        f.responses.get(paths.logs).data = logFixture
          .replaceAll(shape.mergeCommit.sha, shape.pr.head.sha)
          .replace("HEAD is now at ccccccc", "HEAD is now at bbbbbbb");
        f.responses.set(`${root}/git/commits/${shape.pr.head.sha}`, {
          status: 200,
          headers: {},
          complete: true,
          data: { sha: shape.pr.head.sha, parents: [{ sha: shape.pr.base.sha }] },
        });
      }
      const bundle = await f.run();
      assert.equal(bundle.status, "verified");
      assert.equal(bundle.evidence.checkout.value.mode, mode);
      assert.equal(bundle.evidence.checkout.value.attempt, 2);
      assert.equal(bundle.evidence.requiredCheck.value.job.id, 82);
      assert.equal(bundle.evidence.actualTestJob.value.job.id, 83);
      assert.equal(
        bundle.evidence.comments.value.envelopes[0].bodyDigest,
        f.input.comments[0].bodyDigest,
      );
      assert.deepEqual(bundle.evidence.comments.value.envelopes[0].raw, f.raw(paths.comments)[0]);
      assert.equal(bundle.evidence.stability.status, "verified");
      assert.ok(f.calls.every((call) => call.method === "GET"));
      assert.ok(!f.calls.some((call) => call.path === `${root}/actions/jobs/82/logs`));
    },
  );

  it.each([
    ["pr-head", "pr", "pr-head-base-binding-mismatch"],
    ["pr-base", "pr", "pr-head-base-binding-mismatch"],
    ["parents", "checkout", "checkout-parents-mismatch"],
    ["log-sha", "checkout", "checkout-sha-mismatch"],
    ["run-attempt", "run", "run-binding-mismatch"],
    ["run-head", "run", "run-binding-mismatch"],
    ["run-workflow", "run", "run-binding-mismatch"],
    ["aggregate-attempt", "requiredCheck", "job-check-run-attempt-mismatch"],
    ["test-run", "actualTestJob", "job-check-run-attempt-mismatch"],
    ["test-attempt", "actualTestJob", "job-check-run-attempt-mismatch"],
    ["test-check-head", "actualTestJob", "job-check-run-attempt-mismatch"],
    ["aggregate-check", "requiredCheck", "job-check-binding-mismatch"],
    ["app", "requiredCheck", "job-check-run-attempt-mismatch"],
    ["foreign-check", "actualTestJob", "foreign-or-invalid-job-check-url"],
  ])("blocks %s evidence", async (change, part, reason) => {
    const f = fixture();
    if (change === "pr-head") f.raw(paths.pr).head.sha = "f".repeat(40);
    if (change === "pr-base") f.raw(paths.pr).base.sha = "f".repeat(40);
    if (change === "parents") f.raw(paths.merge).parents[0].sha = "f".repeat(40);
    if (change === "log-sha")
      f.responses.get(paths.logs).data = logFixture
        .replaceAll("ccccccc", "fffffff")
        .replace("cccc", "ffff");
    if (change === "run-attempt") f.raw(paths.run).run_attempt = 1;
    if (change === "run-head") f.raw(paths.run).head_sha = "f".repeat(40);
    if (change === "run-workflow") f.raw(paths.run).workflow_id = 8;
    if (change === "aggregate-attempt") f.raw(paths.aggregateJob).run_attempt = 1;
    if (change === "test-run") f.raw(paths.testJob).run_id = 90;
    if (change === "test-attempt") f.raw(paths.testJob).run_attempt = 1;
    if (change === "test-check-head") f.raw(paths.testCheck).head_sha = "f".repeat(40);
    if (change === "aggregate-check")
      f.raw(paths.aggregateJob).check_run_url = `https://api.github.com${root}/check-runs/999`;
    if (change === "app") f.raw(paths.aggregateCheck).app.id = 500;
    if (change === "foreign-check")
      f.raw(paths.testJob).check_run_url = "https://elsewhere.invalid/check-runs/84";
    const bundle = await f.run();
    noExecution(bundle);
    assert.equal(bundle.evidence[part].reason, reason);
  });

  it.each([
    "absent-job",
    "missing-checkout-step",
    "absent-log",
    "redirect-log",
    "partial-log",
    "truncated",
    "ambiguous",
    "multi-checkout",
    "multi-command",
  ])("does not upgrade aggregate green with %s", async (change) => {
    const f = fixture();
    if (change === "absent-job") f.responses.delete(paths.testJob);
    if (change === "missing-checkout-step") f.raw(paths.testJob).steps = [];
    if (change === "absent-log") f.responses.delete(paths.logs);
    if (change === "redirect-log")
      f.responses.set(paths.logs, {
        status: 302,
        headers: { location: "https://elsewhere.invalid/log" },
      });
    if (change === "partial-log") f.responses.get(paths.logs).complete = false;
    if (change === "truncated")
      f.responses.get(paths.logs).data = logFixture.split("##[group]Run tests")[0];
    if (change === "ambiguous")
      f.responses.get(paths.logs).data = logFixture.replace(
        "HEAD is now at ccccccc",
        "HEAD is now at aaaaaaa",
      );
    if (change === "multi-checkout") f.responses.get(paths.logs).data += logFixture;
    if (change === "multi-command")
      f.responses.get(paths.logs).data += "[command]/usr/bin/git checkout another-branch\n";
    const bundle = await f.run();
    noExecution(bundle);
    assert.equal(bundle.evidence.requiredCheck.status, "verified");
    assert.notEqual(bundle.evidence.checkout.status, "verified");
  });

  it.each([
    "boundary-before-command",
    "boundary-before-head",
    "boundary-before-log",
    "command-before-action",
    "command-after-head",
    "command-after-sha",
    "outside-step-time",
    "missing-step-time",
  ])("rejects checkout evidence with %s", async (change) => {
    const f = fixture();
    const lines = logFixture.trimEnd().split("\n");
    const boundary = "2026-01-01T10:00:03.5000000Z ##[group]Run unrelated";
    const before = {
      "boundary-before-command": 3,
      "boundary-before-head": 4,
      "boundary-before-log": 6,
    };
    if (change in before) lines.splice(before[change], 0, boundary);
    const moves = { "command-before-action": 0, "command-after-head": 4, "command-after-sha": 7 };
    if (change in moves) {
      const [command] = lines.splice(3, 1);
      lines.splice(moves[change], 0, command);
    }
    if (change === "outside-step-time")
      f.raw(paths.testJob).steps[0].completed_at = "2026-01-01T10:00:03Z";
    if (change === "missing-step-time") delete f.raw(paths.testJob).steps[0].started_at;
    f.responses.get(paths.logs).data = lines.join("\n") + "\n";
    const bundle = await f.run();
    noExecution(bundle);
    assert.equal(bundle.evidence.checkout.status, "blocked");
  });

  it.each(["edited", "author", "body", "missing", "unbound"])(
    "fails closed for %s comment",
    async (change) => {
      const f = fixture();
      if (change === "edited") f.raw(paths.comments)[0].updated_at = "2026-01-01T11:00:00Z";
      if (change === "author") f.raw(paths.comments)[0].user.id = 999;
      if (change === "body") f.raw(paths.comments)[0].body += " changed";
      if (change === "missing") f.responses.get(paths.comments).data = [];
      if (change === "unbound") f.input.comments = [];
      const bundle = await f.run();
      noExecution(bundle);
      assert.notEqual(bundle.evidence.comments.status, "verified");
      assert.ok(bundle.evidence.comments.raw);
    },
  );

  it.each([403, 404, 429, 500, 206])("preserves HTTP %s as unusable evidence", async (status) => {
    const f = fixture();
    f.responses.set(paths.pr, { status });
    const bundle = await f.run();
    noExecution(bundle);
    assert.match(bundle.evidence.pr.reason, new RegExp(String(status)));
  });

  it("collects all comment pages and rejects interrupted pagination", async () => {
    const f = fixture();
    const second = {
      ...structuredClone(f.raw(paths.comments)[0]),
      id: 45,
      html_url: `https://github.com/${shape.repository}/pull/12#issuecomment-45`,
    };
    f.input.comments.push({ ...f.input.comments[0], id: 45 });
    let interrupted = false;
    const readTransport = async (request) => {
      if (request.path !== paths.comments) return f.transport(request);
      if (request.query.page === 2)
        return interrupted
          ? { status: 429 }
          : { status: 200, headers: {}, complete: true, data: [second] };
      const response = await f.transport(request);
      response.headers.Link = `<https://api.github.com${paths.comments}?per_page=100&page=2>; rel="next"`;
      return response;
    };
    assert.equal((await f.run({ readTransport })).evidence.comments.value.envelopes.length, 2);
    interrupted = true;
    const bundle = await f.run({ readTransport });
    noExecution(bundle);
    assert.equal(bundle.evidence.comments.reason, "http-429-rate-limited");
    assert.equal(bundle.evidence.comments.raw.complete, false);
  });

  it.each(["pr", "comments", "run", "testJob"])(
    "detects %s changes on the closing read",
    async (resource) => {
      const f = fixture();
      let reads = 0;
      const readTransport = async (request) => {
        const response = await f.transport(request);
        if (request.path === paths[resource] && ++reads === 2) {
          if (resource === "comments") response.data[0].body += " edited later";
          else response.data.changed = true;
        }
        return response;
      };
      const bundle = await f.run({ readTransport });
      noExecution(bundle);
      assert.equal(bundle.evidence.stability.status, "blocked");
    },
  );

  it("reports only observed publication, even for a previously published SHA", async () => {
    const f = fixture();
    f.raw(paths.pr).created_at = "2020-01-01T00:00:00Z";
    f.raw(paths.merge).committer = { date: "1999-01-01T00:00:00Z" };
    let calls = 0;
    const bundle = await f.run({
      now: () => (calls++ === 0 ? "2026-01-02T11:00:00Z" : observedAt),
    });
    assert.equal(bundle.evidence.publication.value.observedAt, observedAt);
    assert.equal(bundle.collectionStartedAt, "2026-01-02T11:00:00Z");
    assert.equal(bundle.evidence.publication.reason, "published-at-observation-only");
    assert.equal(JSON.stringify(bundle.evidence.publication).includes("firstPublishedAt"), false);
    assert.equal(JSON.stringify(bundle.evidence.publication).includes("1999"), false);
  });

  it("rejects incomplete bindings and missing transport without side effects", async () => {
    const f = fixture();
    const bad = structuredClone(f.input);
    delete bad.expectedBase;
    noExecution(await f.run({ input: bad }));
    noExecution(await f.run({ readTransport: undefined }));
    assert.equal(f.calls.length, 0);
  });
});
