import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { assert, describe, expect, it } from "vite-plus/test";
import fixture from "./testFixtures/ops-github-evidence.json";
import { acquireSlot, createMockContentsRemote } from "./ops-contents-slot.mjs";
import { reconcile } from "./ops-reconciler.mjs";
import {
  createReadOnlyAdapters,
  decodeContents,
  lookupReceipt,
  normalizeCI,
  normalizeContentsUpdate,
  normalizeIssueComment,
  normalizePage,
  normalizePullRequest,
  planContentsUpdate,
  publicationEvidence,
  recordReceipt,
} from "./ops-evidence-adapters.mjs";

const repository = fixture.repository;
const trusted = {
  repository,
  repositoryId: 123,
  workflowId: 7,
  workflowPath: ".github/workflows/ci.yml",
  workflow: "CI",
  checkAppId: 99,
  check: "Check",
};
const ciInput = () => ({
  ...structuredClone(fixture),
  pr: normalizePullRequest(fixture.pr, repository),
});
const path = "ops/execution-slot.json";
const slot = () => {
  const remote = createMockContentsRemote();
  acquireSlot({ remote, taskId: "fixture-task", workerId: "fixture-worker" });
  return remote.read().record;
};
const contents = (record) => {
  const bytes = Buffer.from(JSON.stringify(record));
  return {
    status: 200,
    data: {
      type: "file",
      path,
      encoding: "base64",
      size: bytes.length,
      sha: NodeCrypto.createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex"),
      content: bytes.toString("base64"),
    },
  };
};
const receiptEntry = (kind, state = "pending") => {
  const binding =
    kind === "review"
      ? { ownerId: "reviewer", key: "task:sha:44", headSha: fixture.pr.head.sha }
      : { taskId: "fixture-task", workerId: "fixture-worker", startingSha: fixture.pr.head.sha };
  const receipt =
    kind === "review"
      ? {
          ...binding,
          requestId: "intent-1",
          decision: "ACCEPTED",
          evidence: "https://example.invalid/review",
        }
      : { ...binding, dispatchId: "intent-1", url: "https://example.invalid/start" };
  return { kind, id: "intent-1", binding, state, receipt: state === "confirmed" ? receipt : null };
};

describe("offline GitHub evidence boundaries", () => {
  it("uses API numeric author identity and preserves legacy bodies without inventing packets", () => {
    const comment = normalizeIssueComment(
      {
        ...fixture.comment,
        author_association: "OWNER",
        body: "authorId: trusted-owner\nworker_state: COMPLETED",
      },
      repository,
      12,
    );
    assert.equal(comment.authorId, "91");
    assert.equal(comment.authorType, "Bot");
    assert.equal(comment.body, "authorId: trusted-owner\nworker_state: COMPLETED");
    assert.throws(() => JSON.parse(comment.body));
    assert.throws(() =>
      normalizeIssueComment(
        { ...fixture.comment, issue_url: "https://api.github.com/repos/other/repo/issues/12" },
        repository,
        12,
      ),
    );
  });

  it("normalizes native JSON result bodies without accepting claimed body authors", () => {
    const body = JSON.stringify({ kind: "implementation_result", authorId: "spoof" });
    const result = normalizeIssueComment({ ...fixture.comment, body }, repository, 12);
    assert.equal(result.body, body);
    assert.equal(result.authorId, "91");
  });

  it.each(["fork", "closed", "missing-base"])("blocks unsupported PR evidence: %s", (change) => {
    const pr = structuredClone(fixture.pr);
    if (change === "fork") pr.head.repo.full_name = "another/repo";
    if (change === "closed") pr.state = "closed";
    if (change === "missing-base") pr.base.sha = null;
    assert.throws(() => normalizePullRequest(pr, repository));
  });

  it("reads all PR pages and comment pages through GET-only fake transport", async () => {
    const calls = [];
    const readTransport = async (request) => {
      calls.push(request);
      const comment = request.path.endsWith("comments");
      const query = comment ? "per_page=100" : "state=all&per_page=100";
      return {
        status: 200,
        headers:
          request.query.page === 1
            ? {
                link: `<https://api.github.com${request.path}?${query}&page=2>; rel="next"`,
              }
            : {},
        data: [
          structuredClone(comment ? { ...fixture.comment, body: "Taking a look!" } : fixture.pr),
        ],
      };
    };
    const { github } = createReadOnlyAdapters({ repository, readTransport });
    const first = await github.listPullRequests({ cursor: null });
    assert.equal(first.nextCursor, "2");
    assert.equal((await github.listPullRequests({ cursor: first.nextCursor })).nextCursor, null);
    const comments = await github.listComments({ prNumber: 12, cursor: null });
    assert.equal(
      (await github.listComments({ prNumber: 12, cursor: comments.nextCursor })).nextCursor,
      null,
    );
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.equal(calls[0].query.state, "all");
    assert.equal(comments.items[0].authorId, "91");
  });

  it.each(["Link", "LINK", "Headers"])("reads pagination from %s headers", (kind) => {
    const link = `<https://api.github.com/repos/${repository}/pulls?state=all&per_page=100&page=2>; rel="next"`;
    const headers = kind === "Headers" ? new Headers({ Link: link }) : { [kind]: link };
    const result = normalizePage(
      { status: 200, data: [], headers },
      {
        path: `/repos/${repository}/pulls`,
        query: { state: "all", per_page: 100 },
        page: 1,
      },
    );
    assert.equal(result.nextCursor, "2");
  });

  it.each([new Map(), new Date(0), { get: () => null }, Object.create({ Link: "hidden" })])(
    "rejects unsupported header containers instead of claiming a final page",
    (headers) => {
      assert.throws(() =>
        normalizePage(
          { status: 200, data: [], headers },
          {
            path: "/pulls",
            query: {},
            page: 1,
          },
        ),
      );
    },
  );

  it("rejects ambiguous case-duplicate Link fields", () => {
    assert.throws(() =>
      normalizePage(
        { status: 200, data: [], headers: { link: "", Link: "" } },
        {
          path: "/pulls",
          query: {},
          page: 1,
        },
      ),
    );
  });

  it.each([
    "https://evil.invalid/repos/fixture-owner/fixture-repo/pulls?state=all&per_page=100&page=2",
    "https://api.github.com/repos/other/repo/pulls?state=all&per_page=100&page=2",
    "https://api.github.com/repos/fixture-owner/fixture-repo/pulls?state=all&per_page=100&page=1",
    "https://api.github.com/repos/fixture-owner/fixture-repo/pulls?state=all&per_page=100&page=3",
    "https://api.github.com/repos/fixture-owner/fixture-repo/pulls?state=open&per_page=100&page=2",
  ])("rejects foreign, cyclic, skipped or scope-changing page links: %s", (url) => {
    assert.throws(() =>
      normalizePage(
        { status: 200, data: [], headers: { link: `<${url}>; rel="next"` } },
        { path: `/repos/${repository}/pulls`, query: { state: "all", per_page: 100 }, page: 1 },
      ),
    );
  });

  it("does not turn incomplete or failed discovery into an empty successful page", () => {
    const request = { path: "/pulls", query: {}, page: 1 };
    assert.throws(() => normalizePage({ status: 403, data: [] }, request));
    assert.throws(() => normalizePage({ status: 200, data: [] }, request));
    assert.throws(() =>
      normalizePage({ status: 200, data: [], headers: { link: "truncated" } }, request),
    );
  });

  it("cannot infer first publication or actual checkout from a green API response", async () => {
    assert.equal(
      publicationEvidence({ commitDate: "2026-01-01", pushEvent: {}, observedAt: "now" }).status,
      "unknown",
    );
    const input = ciInput();
    delete input.checkout;
    assert.deepEqual(normalizeCI(input, trusted), {
      status: "unknown",
      reason: "actual-checkout-not-proven",
    });
    const { github } = createReadOnlyAdapters({ repository });
    await expect(github.getPublication({})).rejects.toThrow("first-publication-not-proven");
    await expect(github.getCI({})).rejects.toThrow("ci-checkout-provenance-unavailable");
  });

  it("binds synthetic checkout to exact workflow, check, attempt, head and merge parents", () => {
    const input = ciInput();
    const result = normalizeCI(input, trusted);
    assert.equal(result.status, "fixture-only");
    assert.equal(result.value.checkoutSha, fixture.mergeCommit.sha);
    assert.deepEqual(
      result.value.mergeParents,
      fixture.mergeCommit.parents.map((p) => p.sha),
    );
    input.checkout.sha = input.pr.headSha;
    assert.equal(normalizeCI(input, trusted).value.checkoutSha, input.pr.headSha);
  });

  it.each([
    "workflow",
    "app",
    "suite",
    "head",
    "attempt",
    "job-attempt",
    "job-check",
    "parents",
    "untrusted-source",
  ])("blocks mismatched CI provenance: %s", (change) => {
    const input = ciInput();
    if (change === "workflow") input.run.workflow_id = 999;
    if (change === "app") input.check.app.id = 999;
    if (change === "suite") input.check.check_suite.id = 999;
    if (change === "head") input.run.head_sha = "d".repeat(40);
    if (change === "attempt") input.checkout.attempt = 1;
    if (change === "job-attempt") input.job.run_attempt = 1;
    if (change === "job-check") input.job.check_run_url = "https://example.invalid/wrong-check";
    if (change === "parents") input.mergeCommit.parents[0].sha = "d".repeat(40);
    if (change === "untrusted-source") input.checkout.source = "comment-claims-checkout";
    assert.throws(() => normalizeCI(input, trusted));
  });

  it("preserves failed CI rather than normalizing it to success", () => {
    const input = ciInput();
    input.run.conclusion = input.check.conclusion = input.job.conclusion = "failure";
    assert.equal(normalizeCI(input, trusted).value.conclusion, "failure");
  });

  it("decodes an exact Contents blob and plans CAS without sending", () => {
    const current = decodeContents(contents(slot()), path);
    const record = { ...current.record, generation: current.record.generation + 1, nonce: "fresh" };
    const plan = planContentsUpdate({
      current,
      expectedBlobSha: current.blobSha,
      record,
      branch: "fixture-slot",
      path,
    });
    assert.equal(plan.body.sha, current.blobSha);
    assert.equal(plan.body.branch, "fixture-slot");
    assert.equal(normalizeContentsUpdate({ status: 409 }, plan).ok, false);
    assert.equal(normalizeContentsUpdate({ status: 422 }, plan).reason, "validation-rejected");
    assert.equal(normalizeContentsUpdate(undefined, plan).reason, "write-outcome-unknown");
    assert.equal(
      normalizeContentsUpdate(
        { status: 200, data: { content: { sha: plan.expectedResultSha, path } } },
        plan,
      ).ok,
      true,
    );
    assert.throws(() =>
      normalizeContentsUpdate(
        { status: 200, data: { content: { sha: current.blobSha, path } } },
        plan,
      ),
    );
    assert.throws(() =>
      planContentsUpdate({
        current,
        expectedBlobSha: "f".repeat(40),
        record,
        branch: "fixture-slot",
        path,
      }),
    );
    assert.throws(() =>
      planContentsUpdate({
        current,
        expectedBlobSha: current.blobSha,
        record: current.record,
        branch: "fixture-slot",
        path,
      }),
    );
  });

  it("does not bootstrap missing, malformed or tampered Contents", () => {
    assert.equal(decodeContents({ status: 404 }, path).status, "unknown");
    const raw = contents(slot());
    raw.data.sha = "f".repeat(40);
    assert.throws(() => decodeContents(raw, path));
    assert.throws(() => decodeContents(contents({ state: "TERMINAL" }), path));
    assert.throws(() => decodeContents({ status: 200, data: [] }, path));
  });

  it("never invokes transport for write, review or start, even with enable flags", () => {
    let calls = 0;
    const adapters = createReadOnlyAdapters({
      repository,
      enableWrites: true,
      readTransport: () => {
        calls += 1;
        throw new Error("unexpected transport");
      },
    });
    assert.throws(() => adapters.remote.compareAndSwap({}), /offline-write-disabled/);
    assert.throws(() => adapters.reviewer.review({}), /offline-write-disabled/);
    assert.throws(() => adapters.worker.start({}), /offline-write-disabled/);
    assert.equal(calls, 0);
  });

  it.each(["legacy", "native-json"])(
    "blocks %s results without a write or start",
    async (format) => {
      const record = slot();
      const reads = [];
      const adapters = createReadOnlyAdapters({
        repository,
        readTransport: async (request) => {
          reads.push(request);
          if (request.path.includes("/contents/")) return contents(record);
          return {
            status: 200,
            headers: {},
            data: [
              request.path.endsWith("comments")
                ? {
                    ...fixture.comment,
                    body:
                      format === "legacy"
                        ? fixture.comment.body
                        : JSON.stringify({
                            kind: "implementation_result",
                            taskId: "fixture-task",
                            workerId: "fixture-worker",
                            branch: fixture.pr.head.ref,
                            startingSha: fixture.pr.base.sha,
                            finalSha: fixture.pr.head.sha,
                            prNumber: 12,
                            workerState: "COMPLETED",
                            classification: "code",
                            predecessor: null,
                            dependencies: [],
                          }),
                  }
                : fixture.pr,
            ],
          };
        },
      });
      const outcome = await reconcile({
        ...adapters,
        source: "periodic",
        ownerId: "reviewer",
        tasks: [
          {
            id: "fixture-task",
            workerId: "fixture-worker",
            resultAuthorId: "91",
            branch: fixture.pr.head.ref,
            baseBranch: fixture.pr.base.ref,
            scope: "offline",
            startingSha: fixture.pr.base.sha,
            requiredCI: { workflow: "CI", check: "Check" },
            predecessor: null,
            dependencies: [],
          },
        ],
      });
      assert.equal(outcome.status, "BLOCKED");
      assert.equal(
        outcome.reason,
        format === "legacy" ? "legacy-result-format-unapproved" : "offline-write-disabled",
      );
      assert.ok(reads.every((read) => read.method === "GET"));
    },
  );
});

describe("offline receipt journals", () => {
  it.each(["review", "start"])(
    "recovers %s mapping across file reopen without a send",
    async (kind) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ops-receipts-"));
      const file = NodePath.join(directory, "receipts.json");
      try {
        let snapshot = { version: 1, entries: [] };
        const open = () => ({ read: async () => JSON.parse(NodeFS.readFileSync(file, "utf8")) });
        const entry = receiptEntry(kind);
        assert.equal(
          lookupReceipt(snapshot, kind, entry.id, entry.binding).reason,
          "receipt-not-observed",
        );
        snapshot = recordReceipt(snapshot, entry);
        snapshot = recordReceipt(snapshot, { ...entry, state: "uncertain" });
        NodeFS.writeFileSync(file, JSON.stringify(snapshot));
        let adapters = createReadOnlyAdapters({
          repository,
          receiptStore: open(),
          receiptBindings: { [`${kind}:${entry.id}`]: entry.binding },
        });
        const lookup = (a) =>
          kind === "review" ? a.reviewer.findReview(entry.id) : a.worker.findStart(entry.id);
        assert.equal(await lookup(adapters), null);
        snapshot = recordReceipt(await open().read(), receiptEntry(kind, "confirmed"));
        NodeFS.writeFileSync(file, JSON.stringify(snapshot));
        adapters = createReadOnlyAdapters({
          repository,
          receiptStore: open(),
          receiptBindings: { [`${kind}:${entry.id}`]: entry.binding },
        });
        assert.deepEqual(await lookup(adapters), receiptEntry(kind, "confirmed").receipt);
        assert.throws(() => adapters.worker.start({}), /offline-write-disabled/);
        assert.throws(() => adapters.reviewer.review({}), /offline-write-disabled/);
        assert.equal(snapshot.entries.length, 1);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects binding changes, duplicate keys, missing authority and receipt regressions", () => {
    const entry = receiptEntry("start", "confirmed");
    const snapshot = recordReceipt({ version: 1, entries: [] }, entry);
    assert.throws(() =>
      lookupReceipt(snapshot, "start", entry.id, { ...entry.binding, workerId: "other" }),
    );
    assert.throws(() => lookupReceipt(snapshot, "start", entry.id, undefined));
    assert.throws(() => recordReceipt(snapshot, receiptEntry("start")));
    assert.throws(() =>
      lookupReceipt({ ...snapshot, entries: [entry, entry] }, "start", entry.id, entry.binding),
    );
    assert.throws(() =>
      recordReceipt(snapshot, { ...entry, receipt: { ...entry.receipt, dispatchId: "other" } }),
    );
    const uncertain = recordReceipt(
      { version: 1, entries: [] },
      receiptEntry("start", "uncertain"),
    );
    assert.throws(() => recordReceipt(uncertain, receiptEntry("start", "pending")));
  });
});
