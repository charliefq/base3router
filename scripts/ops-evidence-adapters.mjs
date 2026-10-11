/** Offline evidence contracts. No HTTP client, credentials, CLI, or send capability. */
import * as NodeCrypto from "node:crypto";
import { recordValid } from "./ops-contents-slot.mjs";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
const requireEvidence = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const unknown = (reason) => ({ status: "unknown", reason });
const fingerprint = (value) => JSON.stringify(value);
const deny = () => {
  throw new Error("offline-write-disabled");
};

export function normalizePullRequest(raw, repository) {
  requireEvidence(
    id(raw?.number) &&
      raw.base?.repo?.full_name === repository &&
      raw.head?.repo?.full_name === repository &&
      text(raw.head.ref) &&
      text(raw.base.ref) &&
      sha(raw.head.sha) &&
      sha(raw.base.sha) &&
      raw.state === "open",
    "unsupported-or-mismatched-pr",
  );
  return {
    number: raw.number,
    branch: raw.head.ref,
    baseBranch: raw.base.ref,
    headSha: raw.head.sha,
    baseSha: raw.base.sha,
    // Closed/merged PR merge_commit_sha has different semantics; rejected above.
    mergeSha: sha(raw.merge_commit_sha) ? raw.merge_commit_sha : null,
  };
}

export function normalizeIssueComment(raw, repository, prNumber) {
  const prefix = `https://github.com/${repository}/pull/${prNumber}#issuecomment-`;
  requireEvidence(
    id(raw?.id) &&
      id(raw.user?.id) &&
      ["User", "Bot"].includes(raw.user.type) &&
      raw.html_url === `${prefix}${raw.id}` &&
      raw.issue_url === `https://api.github.com/repos/${repository}/issues/${prNumber}` &&
      typeof raw.body === "string" &&
      Number.isFinite(Date.parse(raw.created_at)),
    "invalid-comment-envelope",
  );
  // Body text, login, author_association and bot status confer no authority.
  // Legacy prose/key-value reports are not guessed into executable result packets.
  return {
    id: String(raw.id),
    authorId: String(raw.user.id),
    authorType: raw.user.type,
    url: raw.html_url,
    createdAt: raw.created_at,
    body: raw.body,
    resultFormat: /^\s*(?:dispatch_id|worker_state|final_sha):/m.test(raw.body)
      ? "legacy-unapproved"
      : "unchanged",
  };
}

export function normalizePage(response, { path, query, page }) {
  requireEvidence(response?.status === 200 && Array.isArray(response.data), "page-unavailable");
  requireEvidence(id(page), "invalid-page-number");
  requireEvidence(
    response.headers !== null &&
      typeof response.headers === "object" &&
      !Array.isArray(response.headers),
    "missing-page-headers",
  );
  const link = response.headers?.link;
  let nextCursor = null;
  if (link !== undefined) {
    requireEvidence(typeof link === "string", "invalid-link-header");
    for (const part of link.split(",")) {
      const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(part);
      requireEvidence(match, "invalid-link-header");
      if (match[2] !== "next") continue;
      const url = new URL(match[1]);
      requireEvidence(
        nextCursor === null &&
          url.origin === "https://api.github.com" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.pathname === path &&
          [...url.searchParams.keys()].every((key) => key === "page" || key in query) &&
          Object.entries(query).every(
            ([key, value]) => url.searchParams.get(key) === String(value),
          ) &&
          url.searchParams.getAll("page").length === 1 &&
          url.searchParams.get("page") === String(page + 1),
        "unsafe-or-noncontiguous-pagination",
      );
      nextCursor = String(page + 1);
    }
  }
  return { items: structuredClone(response.data), nextCursor };
}

// A commit timestamp, poll time, or isolated push event cannot prove first publication.
export const publicationEvidence = () => unknown("first-publication-not-proven");

export function normalizeCI({ pr, run, check, job, checkout, mergeCommit }, trusted) {
  requireEvidence(
    id(trusted.repositoryId) &&
      id(trusted.workflowId) &&
      id(trusted.checkAppId) &&
      text(trusted.repository) &&
      text(trusted.workflowPath) &&
      text(trusted.workflow) &&
      text(trusted.check) &&
      run?.repository?.id === trusted.repositoryId &&
      id(run.id) &&
      id(run.run_attempt) &&
      run.workflow_id === trusted.workflowId &&
      run.path === trusted.workflowPath &&
      run.name === trusted.workflow &&
      run.event === "pull_request" &&
      run.head_sha === pr.headSha &&
      run.head_branch === pr.branch &&
      run.pull_requests?.some(
        (entry) =>
          entry.number === pr.number &&
          entry.head?.sha === pr.headSha &&
          entry.base?.sha === pr.baseSha,
      ) &&
      id(check?.id) &&
      check.app?.id === trusted.checkAppId &&
      check.name === trusted.check &&
      check.check_suite?.id === run.check_suite_id &&
      id(run.check_suite_id) &&
      check.head_sha === pr.headSha &&
      check.status === run.status &&
      check.conclusion === run.conclusion &&
      run.html_url === `https://github.com/${trusted.repository}/actions/runs/${run.id}` &&
      id(job?.id) &&
      job.run_id === run.id &&
      job.run_attempt === run.run_attempt &&
      job.name === check.name &&
      job.status === check.status &&
      job.conclusion === check.conclusion &&
      job.check_run_url ===
        `https://api.github.com/repos/${trusted.repository}/check-runs/${check.id}`,
    "ci-identity-mismatch",
  );
  if (!checkout) return unknown("actual-checkout-not-proven");
  // Only synthetic checkout evidence is defined in this slice. This is not a
  // verified attestation format or an API claiming GitHub returns actual checkout.
  requireEvidence(
    checkout.source === "synthetic-fixture" &&
      checkout.runId === run.id &&
      checkout.attempt === run.run_attempt &&
      sha(checkout.sha),
    "unsupported-checkout-evidence",
  );
  const direct = checkout.sha === pr.headSha;
  const parents = mergeCommit?.parents?.map((parent) => parent.sha);
  requireEvidence(
    direct ||
      (checkout.sha === pr.mergeSha &&
        mergeCommit?.sha === checkout.sha &&
        parents?.length === 2 &&
        parents.includes(pr.headSha) &&
        parents.includes(pr.baseSha)),
    "ci-checkout-mismatch",
  );
  return {
    status: "fixture-only",
    value: {
      workflow: run.name,
      check: check.name,
      id: `${run.id}:${run.run_attempt}:${check.id}`,
      url: run.html_url,
      headSha: run.head_sha,
      checkoutSha: checkout.sha,
      baseSha: pr.baseSha,
      mergeParents: direct ? [] : parents,
      status: check.status,
      conclusion: check.conclusion,
    },
  };
}

const blobSha = (bytes) =>
  NodeCrypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export function decodeContents(response, path) {
  if (response?.status === 404)
    return { status: "unknown", reason: "missing-or-inaccessible-slot" };
  const raw = response?.data;
  requireEvidence(
    response?.status === 200 &&
      raw?.type === "file" &&
      raw.path === path &&
      raw.encoding === "base64" &&
      typeof raw.content === "string" &&
      sha(raw.sha),
    "invalid-contents",
  );
  const encoded = raw.content.replace(/\s/g, "");
  const bytes = Buffer.from(encoded, "base64");
  requireEvidence(
    bytes.toString("base64") === encoded && bytes.length === raw.size && blobSha(bytes) === raw.sha,
    "contents-integrity-mismatch",
  );
  const record = JSON.parse(bytes.toString("utf8"));
  requireEvidence(recordValid(record), "invalid-slot-record");
  return { status: "ok", blobSha: raw.sha, record };
}

// Pure request description for contract tests. No caller in this module sends it.
export function planContentsUpdate({ current, expectedBlobSha, record, branch, path }) {
  requireEvidence(
    current?.status === "ok" &&
      recordValid(current.record) &&
      sha(expectedBlobSha) &&
      current.blobSha === expectedBlobSha,
    "stale-or-unknown-slot",
  );
  requireEvidence(
    recordValid(record) &&
      record.generation === current.record.generation + 1 &&
      record.nonce !== current.record.nonce &&
      text(branch) &&
      text(path),
    "invalid-slot-transition",
  );
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  return {
    path,
    expectedResultSha: blobSha(bytes),
    body: {
      branch,
      sha: expectedBlobSha,
      message: "Update coordination checkpoint",
      content: bytes.toString("base64"),
    },
  };
}

export function normalizeContentsUpdate(response, plan) {
  if (response?.status === 409) return { ok: false, status: 409, reason: "cas-conflict" };
  if (response?.status === 422) return { ok: false, status: 422, reason: "validation-rejected" };
  if (response?.status !== 200) return { ok: false, reason: "write-outcome-unknown" };
  requireEvidence(
    response.data?.content?.sha === plan.expectedResultSha &&
      response.data.content.path === plan.path,
    "write-receipt-mismatch",
  );
  return { ok: true, blobSha: plan.expectedResultSha };
}

function bindingFor(kind, binding) {
  const fields =
    kind === "review"
      ? ["ownerId", "key", "headSha"]
      : kind === "start"
        ? ["taskId", "workerId", "startingSha"]
        : [];
  requireEvidence(
    fields.length > 0 &&
      fields.every((field) => text(binding?.[field])) &&
      sha(binding[kind === "review" ? "headSha" : "startingSha"]),
    "invalid-receipt-binding",
  );
  return Object.fromEntries(fields.map((field) => [field, binding[field]]));
}

function validateReceipt(entry) {
  const binding = bindingFor(entry.kind, entry.binding);
  requireEvidence(
    text(entry.id) && ["pending", "uncertain", "confirmed"].includes(entry.state),
    "invalid-receipt-state",
  );
  if (entry.state !== "confirmed") {
    requireEvidence(entry.receipt === null, "unconfirmed-receipt-present");
    return;
  }
  const receipt = entry.receipt;
  requireEvidence(
    receipt &&
      Object.entries(binding).every(([key, value]) => receipt[key] === value) &&
      (entry.kind === "review"
        ? receipt.requestId === entry.id &&
          ["ACCEPTED", "CHANGES_REQUIRED"].includes(receipt.decision) &&
          text(receipt.evidence)
        : receipt.dispatchId === entry.id && text(receipt.url)),
    "receipt-binding-mismatch",
  );
}

function validateJournal(snapshot) {
  requireEvidence(
    snapshot?.version === 1 && Array.isArray(snapshot.entries),
    "invalid-receipt-journal",
  );
  const seen = new Set();
  for (const entry of snapshot.entries) {
    validateReceipt(entry);
    const key = `${entry.kind}:${entry.id}`;
    requireEvidence(!seen.has(key), "duplicate-receipt-key");
    seen.add(key);
  }
}

// Pure snapshot transition. Durable writes/CAS belong to a future reviewed store.
export function recordReceipt(snapshot, entry) {
  validateJournal(snapshot);
  validateReceipt(entry);
  const next = structuredClone(snapshot);
  const existing = next.entries.find((item) => item.kind === entry.kind && item.id === entry.id);
  if (existing) {
    requireEvidence(
      fingerprint(bindingFor(existing.kind, existing.binding)) ===
        fingerprint(bindingFor(entry.kind, entry.binding)),
      "changed-receipt-binding",
    );
    requireEvidence(
      existing.state !== "confirmed" ||
        fingerprint(existing.receipt) === fingerprint(entry.receipt),
      "changed-confirmed-receipt",
    );
    requireEvidence(
      !(existing.state === "uncertain" && entry.state === "pending"),
      "receipt-state-regression",
    );
    Object.assign(existing, structuredClone(entry));
  } else next.entries.push(structuredClone(entry));
  return next;
}

export function lookupReceipt(snapshot, kind, key, binding) {
  validateJournal(snapshot);
  const expected = bindingFor(kind, binding);
  const entry = snapshot.entries.find((item) => item.kind === kind && item.id === key);
  if (!entry) return unknown("receipt-not-observed");
  requireEvidence(
    fingerprint(bindingFor(kind, entry.binding)) === fingerprint(expected),
    "changed-receipt-binding",
  );
  return entry.state === "confirmed"
    ? { status: "confirmed", receipt: structuredClone(entry.receipt) }
    : unknown(`receipt-${entry.state}`);
}

export function createReadOnlyAdapters({
  repository,
  readTransport,
  receiptStore,
  receiptBindings = {},
}) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository), "invalid-repository");
  const base = `/repos/${repository}`;
  const get = async (path, query = {}) => {
    requireEvidence(typeof readTransport === "function", "read-transport-unavailable");
    return readTransport({ method: "GET", path, query });
  };
  const list = async (path, query, cursor) => {
    const page = cursor === null ? 1 : Number(cursor);
    requireEvidence(id(page) && (cursor === null || String(page) === cursor), "invalid-cursor");
    return normalizePage(await get(path, { ...query, page }), { path, query, page });
  };
  const lookup = async (kind, key) => {
    requireEvidence(typeof receiptStore?.read === "function", "receipt-store-unavailable");
    const result = lookupReceipt(
      await receiptStore.read(),
      kind,
      key,
      receiptBindings[`${kind}:${key}`],
    );
    return result.status === "confirmed" ? result.receipt : null;
  };
  return {
    github: {
      async listPullRequests({ cursor }) {
        const page = await list(`${base}/pulls`, { state: "all", per_page: 100 }, cursor);
        requireEvidence(
          page.items.every((pr) => id(pr?.number) && pr.base?.repo?.full_name === repository),
          "invalid-pr-page",
        );
        return { ...page, items: page.items.map((pr) => ({ number: pr.number })) };
      },
      async listComments({ prNumber, cursor }) {
        requireEvidence(id(prNumber), "invalid-pr-number");
        const page = await list(`${base}/issues/${prNumber}/comments`, { per_page: 100 }, cursor);
        const items = page.items.map((raw) => normalizeIssueComment(raw, repository, prNumber));
        requireEvidence(
          !items.some((item) => item.resultFormat === "legacy-unapproved"),
          "legacy-result-format-unapproved",
        );
        return { ...page, items };
      },
      async getPullRequest(number) {
        requireEvidence(id(number), "invalid-pr-number");
        const response = await get(`${base}/pulls/${number}`);
        requireEvidence(
          response?.status === 200 && response.data?.number === number,
          "pr-unavailable",
        );
        return normalizePullRequest(response.data, repository);
      },
      async getPublication() {
        throw new Error(publicationEvidence().reason);
      },
      async getCI() {
        throw new Error("ci-checkout-provenance-unavailable");
      },
    },
    remote: {
      async read() {
        const path = "ops/execution-slot.json";
        return decodeContents(
          await get(`${base}/contents/${path}`, { ref: "ops/base3-execution-slot" }),
          path,
        );
      },
      compareAndSwap: deny,
    },
    reviewer: { review: deny, findReview: (key) => lookup("review", key) },
    worker: { start: deny, findStart: (key) => lookup("start", key) },
  };
}
