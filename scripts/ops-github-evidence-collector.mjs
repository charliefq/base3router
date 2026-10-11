/** Read-only evidence capture. No default transport, credentials, CLI or execution imports. */
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import {
  normalizeIssueComment,
  normalizePage,
  normalizePullRequest,
} from "./ops-evidence-adapters.mjs";

const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value) => typeof value === "string" && value.length > 0;
const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
class EvidenceError extends Error {
  constructor(reason, status = "blocked") {
    super(reason);
    this.status = status;
  }
}
const requireEvidence = (condition, reason, status) => {
  if (!condition) throw new EvidenceError(reason, status);
};
const verified = (value, reason = "bound-observation") => ({ status: "verified", reason, value });
const unknown = (reason) => ({ status: "unknown", reason });

function validateInput(input) {
  requireEvidence(
    input &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repository) &&
      id(input.repositoryId) &&
      id(input.prNumber) &&
      sha(input.expectedHead) &&
      sha(input.expectedBase) &&
      id(input.runId) &&
      id(input.attempt) &&
      id(input.actualTestJobId) &&
      text(input.actualTestStep?.name) &&
      input.actualTestStep.name !== "Checkout" &&
      id(input.actualTestStep.number) &&
      id(input.requiredWorkflow?.id) &&
      text(input.requiredWorkflow.name) &&
      /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(input.requiredWorkflow.path) &&
      id(input.requiredCheck?.id) &&
      id(input.requiredCheck.jobId) &&
      id(input.requiredCheck.appId) &&
      text(input.requiredCheck.name) &&
      input.requiredCheck.jobId !== input.actualTestJobId &&
      Array.isArray(input.comments) &&
      input.comments.every(
        (comment) =>
          id(comment?.id) && id(comment.authorId) && /^[a-f0-9]{64}$/.test(comment.bodyDigest),
      ) &&
      new Set(input.comments.map((comment) => comment.id)).size === input.comments.length,
    "invalid-explicit-bindings",
  );
}

function successful(raw, label) {
  requireEvidence(raw.status === "completed", `${label}-not-terminal`, "unknown");
  requireEvidence(raw.conclusion === "success", `${label}-not-successful`);
}

// These log markers are an observation of the trusted job log, not a signed
// attestation. The complete-body assertion belongs to the injected transport.
export function extractCheckoutLog(body, checkoutStep) {
  requireEvidence(typeof body === "string" && body.length > 0, "checkout-log-missing", "unknown");
  const rawLines = body.split(/\r?\n/).map(NodeUtil.stripVTControlCharacters);
  const timestamp = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) /;
  const lines = rawLines.map((line) => line.replace(timestamp, ""));
  const groups = lines
    .map((line, index) => (/^##\[group\]Run actions\/checkout@\S+$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const heads = lines
    .map((line, index) => ({ match: /^HEAD is now at ([a-f0-9]{7,40})(?:\s|$)/.exec(line), index }))
    .filter((entry) => entry.match);
  const commands = lines
    .map((line, index) =>
      /^\[command\](?:\/[^ ]+\/)?git log -1 --format=%H$/.test(line) ? index : -1,
    )
    .filter((index) => index >= 0);
  const checkouts = lines
    .map((line, index) => (/^\[command\].*\bgit\s.*\bcheckout\s/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  requireEvidence(
    groups.length === 1 && heads.length === 1 && commands.length === 1 && checkouts.length === 1,
    "checkout-log-missing-or-ambiguous",
  );
  const command = commands[0];
  const actualSha = lines[command + 1];
  requireEvidence(
    sha(actualSha) &&
      actualSha.startsWith(heads[0].match[1]) &&
      groups[0] < checkouts[0] &&
      checkouts[0] < heads[0].index &&
      heads[0].index < command,
    "checkout-log-inconsistent",
  );
  // Bound markers to the FIRST subsequent Run group, not any later group.
  // A later step echoing plausible git output cannot fill checkout's evidence.
  const nextStep = lines.findIndex(
    (line, index) => index > groups[0] && line.startsWith("##[group]Run "),
  );
  requireEvidence(nextStep >= 0, "checkout-log-truncated", "unknown");
  requireEvidence(command + 1 < nextStep, "checkout-log-crosses-step");
  requireEvidence(
    time(checkoutStep?.started_at) &&
      time(checkoutStep?.completed_at) &&
      Date.parse(checkoutStep.started_at) <= Date.parse(checkoutStep.completed_at),
    "checkout-step-time-unproven",
  );
  // REST step times have second precision. Compare at that same precision;
  // the first subsequent Run boundary still excludes another step in that second.
  const startSecond = Math.floor(Date.parse(checkoutStep.started_at) / 1000);
  const endSecond = Math.floor(Date.parse(checkoutStep.completed_at) / 1000);
  const markerSeconds = [groups[0], checkouts[0], heads[0].index, command, command + 1].map(
    (index) => Math.floor(Date.parse(timestamp.exec(rawLines[index])?.[1]) / 1000),
  );
  requireEvidence(
    markerSeconds.every(
      (second, index) =>
        Number.isFinite(second) &&
        second >= startSecond &&
        second <= endSecond &&
        (index === 0 || second >= markerSeconds[index - 1]),
    ),
    "checkout-log-outside-step-time",
  );
  return { actualSha, bodyDigest: hash(body), headLine: heads[0].index + 1, shaLine: command + 2 };
}

export async function collectGitHubEvidence({
  input,
  readTransport,
  now = () => new Date().toISOString(),
}) {
  const names = [
    "pr",
    "comments",
    "run",
    "requiredCheck",
    "actualJob",
    "actualTestJob",
    "checkout",
    "publication",
    "stability",
  ];
  const evidence = Object.fromEntries(names.map((name) => [name, unknown("not-collected")]));
  let observedAt;
  const finish = () => {
    const statuses = new Set(Object.values(evidence).map((part) => part.status));
    return {
      schema: 1,
      status: statuses.has("blocked")
        ? "blocked"
        : statuses.has("unknown")
          ? "unknown"
          : "verified",
      collectionStartedAt: observedAt,
      evidence,
    };
  };
  try {
    validateInput(input);
    requireEvidence(typeof readTransport === "function", "read-transport-unavailable", "unknown");
    observedAt = now();
    requireEvidence(time(observedAt), "invalid-observation-time");
  } catch (error) {
    evidence.pr = { status: error.status ?? "blocked", reason: error.message };
    return finish();
  }
  const binding = structuredClone(input);
  const root = `/repos/${binding.repository}`;
  const snapshots = new Map();
  const request = async (path, query = {}, format = "json") => {
    let response;
    try {
      response = await readTransport({ method: "GET", path, query, format });
    } catch {
      throw new EvidenceError("read-transport-failed", "unknown");
    }
    if (response?.status === 403) throw new EvidenceError("http-403-forbidden");
    if (response?.status === 404)
      throw new EvidenceError("http-404-missing-or-inaccessible", "unknown");
    if (response?.status === 429) throw new EvidenceError("http-429-rate-limited", "unknown");
    requireEvidence(
      response?.status === 200,
      `http-${response?.status ?? "unknown"}-unusable`,
      "unknown",
    );
    requireEvidence(response.complete === true, "response-completeness-unproven", "unknown");
    return structuredClone({
      ...response,
      headers:
        response.headers instanceof Headers
          ? Object.fromEntries(response.headers.entries())
          : response.headers,
    });
  };
  const json = async (path) => {
    const response = await request(path);
    requireEvidence(
      response.data !== null && typeof response.data === "object" && !Array.isArray(response.data),
      "invalid-json-envelope",
    );
    snapshots.set(path, digest(response.data));
    return response.data;
  };
  const part = async (name, operation) => {
    let raw;
    try {
      evidence[name] = await operation((value) => {
        raw = structuredClone(value);
      });
    } catch (error) {
      evidence[name] = {
        status: error.status ?? "blocked",
        reason: error instanceof EvidenceError ? error.message : "malformed-evidence",
        ...(raw === undefined ? {} : { raw }),
      };
    }
  };
  const dependent = (...parts) => parts.every((name) => evidence[name].status === "verified");

  await part("pr", async (save) => {
    const raw = await json(`${root}/pulls/${binding.prNumber}`);
    save(raw);
    const pr = normalizePullRequest(raw, binding.repository);
    requireEvidence(
      pr.number === binding.prNumber &&
        raw.base.repo.id === binding.repositoryId &&
        raw.head.repo.id === binding.repositoryId &&
        pr.headSha === binding.expectedHead &&
        pr.baseSha === binding.expectedBase,
      "pr-head-base-binding-mismatch",
    );
    const readCompletedAt = now();
    requireEvidence(time(readCompletedAt), "invalid-observation-time");
    return verified({ raw, ...pr, observedAt: readCompletedAt });
  });

  const commentsPath = `${root}/issues/${binding.prNumber}/comments`;
  const readComments = async (save = () => {}) => {
    const comments = [];
    const seen = new Set();
    let cursor = null;
    do {
      const page = cursor === null ? 1 : Number(cursor);
      const query = { per_page: 100 };
      const response = await request(commentsPath, { ...query, page });
      const parsed = normalizePage(response, { path: commentsPath, query, page });
      for (const raw of parsed.items) {
        requireEvidence(!seen.has(raw?.id), "duplicate-comment-across-pages");
        seen.add(raw.id);
        comments.push(raw);
      }
      save({ complete: false, comments });
      cursor = parsed.nextCursor;
      requireEvidence(page < 1000 || cursor === null, "pagination-limit", "unknown");
    } while (cursor !== null);
    return comments;
  };
  let commentDigest;
  await part("comments", async (save) => {
    const raw = await readComments(save);
    const envelopes = raw.map((comment) => {
      normalizeIssueComment(comment, binding.repository, binding.prNumber);
      requireEvidence(time(comment.updated_at), "missing-comment-version");
      return {
        raw: comment,
        id: comment.id,
        authorId: comment.user.id,
        authorType: comment.user.type,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        bodyDigest: hash(comment.body),
      };
    });
    save({ complete: true, envelopes });
    requireEvidence(binding.comments.length > 0, "comment-authority-unbound", "unknown");
    for (const expected of binding.comments) {
      const envelope = envelopes.find((comment) => comment.id === expected.id);
      requireEvidence(envelope, "bound-comment-missing", "unknown");
      requireEvidence(envelope.authorId === expected.authorId, "comment-author-mismatch");
      requireEvidence(envelope.createdAt === envelope.updatedAt, "comment-edited");
      requireEvidence(envelope.bodyDigest === expected.bodyDigest, "comment-body-mismatch");
    }
    commentDigest = digest(raw);
    return verified(
      { complete: true, envelopes, boundCommentIds: binding.comments.map((comment) => comment.id) },
      "snapshot-and-supplied-identity-match-not-role-authorization",
    );
  });

  await part("run", async (save) => {
    const raw = await json(`${root}/actions/runs/${binding.runId}`);
    save(raw);
    requireEvidence(dependent("pr"), "pr-unverified", "unknown");
    const pr = evidence.pr.value;
    requireEvidence(
      raw.id === binding.runId &&
        raw.run_attempt === binding.attempt &&
        raw.repository?.id === binding.repositoryId &&
        raw.repository?.full_name === binding.repository &&
        raw.workflow_id === binding.requiredWorkflow.id &&
        raw.name === binding.requiredWorkflow.name &&
        raw.path === binding.requiredWorkflow.path &&
        raw.event === "pull_request" &&
        raw.head_sha === binding.expectedHead &&
        raw.head_branch === pr.branch &&
        id(raw.check_suite_id) &&
        raw.pull_requests?.some(
          (item) =>
            item.number === binding.prNumber &&
            item.head?.sha === binding.expectedHead &&
            item.base?.sha === binding.expectedBase,
        ),
      "run-binding-mismatch",
    );
    successful(raw, "run");
    return verified(raw);
  });

  const jobAndCheck = async (jobId, checkId, checkName, save) => {
    const job = await json(`${root}/actions/jobs/${jobId}`);
    save({ job });
    const prefix = `https://api.github.com${root}/check-runs/`;
    const checkMatch =
      typeof job.check_run_url === "string" && job.check_run_url.startsWith(prefix)
        ? job.check_run_url.slice(prefix.length)
        : "";
    requireEvidence(
      /^[1-9][0-9]*$/.test(checkMatch) && id(Number(checkMatch)),
      "foreign-or-invalid-job-check-url",
    );
    const actualCheckId = Number(checkMatch);
    requireEvidence(
      checkId === undefined || actualCheckId === checkId,
      "job-check-binding-mismatch",
    );
    const check = await json(`${root}/check-runs/${actualCheckId}`);
    save({ job, check });
    requireEvidence(dependent("run"), "run-unverified", "unknown");
    requireEvidence(
      job.id === jobId &&
        job.run_id === binding.runId &&
        job.run_attempt === binding.attempt &&
        job.head_sha === binding.expectedHead &&
        job.head_branch === evidence.pr.value.branch &&
        job.run_url === `https://api.github.com${root}/actions/runs/${binding.runId}` &&
        check.id === actualCheckId &&
        check.head_sha === binding.expectedHead &&
        check.check_suite?.id === evidence.run.value.check_suite_id &&
        check.app?.id === binding.requiredCheck.appId &&
        text(job.name) &&
        job.name === check.name &&
        (checkName === undefined || check.name === checkName),
      "job-check-run-attempt-mismatch",
    );
    successful(job, "job");
    successful(check, "check");
    return { job, check };
  };
  await part("requiredCheck", async (save) =>
    verified(
      await jobAndCheck(
        binding.requiredCheck.jobId,
        binding.requiredCheck.id,
        binding.requiredCheck.name,
        save,
      ),
    ),
  );
  await part("actualJob", async (save) => {
    const value = await jobAndCheck(binding.actualTestJobId, undefined, undefined, save);
    requireEvidence(value.check.id !== binding.requiredCheck.id, "aggregate-is-not-test-job");
    return verified(value, "job-and-check-status-not-test-step-evidence");
  });
  await part("actualTestJob", async (save) => {
    if (!dependent("actualJob")) return structuredClone(evidence.actualJob);
    const value = evidence.actualJob.value;
    save(value);
    const expected = binding.actualTestStep;
    const candidates = value.job.steps?.filter(
      (step) => step.name === expected.name || step.number === expected.number,
    );
    requireEvidence(
      candidates?.length === 1 &&
        candidates[0].name === expected.name &&
        candidates[0].number === expected.number,
      "test-step-missing-or-ambiguous",
    );
    successful(candidates[0], "test-step");
    return verified(
      {
        ...value,
        testStep: candidates[0],
        provenance: "github-step-status-observation-not-execution-attestation",
      },
      "caller-bound-test-step-completed-successfully",
    );
  });

  await part("checkout", async (save) => {
    requireEvidence(
      dependent("actualJob", "requiredCheck", "pr"),
      "job-or-check-unverified",
      "unknown",
    );
    const checkoutSteps = evidence.actualJob.value.job.steps?.filter(
      (step) => step.name === "Checkout",
    );
    requireEvidence(
      checkoutSteps?.length === 1 &&
        checkoutSteps[0].status === "completed" &&
        checkoutSteps[0].conclusion === "success",
      "checkout-step-missing-or-ambiguous",
    );
    requireEvidence(
      checkoutSteps[0].number !== binding.actualTestStep.number,
      "checkout-is-not-test-step",
    );
    const response = await request(
      `${root}/actions/jobs/${binding.actualTestJobId}/logs`,
      {},
      "text",
    );
    const extracted = extractCheckoutLog(response.data, checkoutSteps[0]);
    save(extracted);
    const direct = extracted.actualSha === binding.expectedHead;
    requireEvidence(
      direct || extracted.actualSha === evidence.pr.value.mergeSha,
      "checkout-sha-mismatch",
    );
    const commit = await json(`${root}/git/commits/${extracted.actualSha}`);
    save({ ...extracted, commit });
    requireEvidence(
      commit.sha === extracted.actualSha && Array.isArray(commit.parents),
      "checkout-commit-mismatch",
    );
    const parents = commit.parents.map((parent) => parent.sha);
    requireEvidence(parents.every(sha), "checkout-parents-malformed");
    requireEvidence(
      direct ||
        (parents.length === 2 &&
          parents.includes(binding.expectedHead) &&
          parents.includes(binding.expectedBase)),
      "checkout-parents-mismatch",
    );
    return verified({
      ...extracted,
      runId: binding.runId,
      attempt: binding.attempt,
      jobId: binding.actualTestJobId,
      mode: direct ? "head" : "test-merge",
      parents,
      provenance: "job-log-observation-not-cryptographic-attestation",
    });
  });

  if (dependent("pr"))
    evidence.publication = verified(
      {
        sha: binding.expectedHead,
        repository: binding.repository,
        branch: evidence.pr.value.branch,
        observedAt: evidence.pr.value.observedAt,
        source: `${root}/pulls/${binding.prNumber}`,
      },
      "published-at-observation-only",
    );

  await part("stability", async () => {
    requireEvidence(
      Object.entries(evidence).every(
        ([name, item]) => name === "stability" || item.status === "verified",
      ),
      "incomplete-evidence",
      "unknown",
    );
    for (const [path, expectedDigest] of snapshots) {
      const response = await request(path);
      requireEvidence(
        digest(response.data) === expectedDigest,
        "evidence-changed-during-collection",
      );
    }
    requireEvidence(
      digest(await readComments()) === commentDigest,
      "comments-changed-during-collection",
    );
    return verified(
      { resourceCount: snapshots.size, commentsRechecked: true },
      "two-read-match-not-atomic-snapshot",
    );
  });
  return finish();
}
