/**
 * Offline coordination kernel. All I/O is injected; there is no CLI, scheduler,
 * GitHub client, credential lookup, or provider implementation in this module.
 * The remote uses the Contents helper's read/compareAndSwap contract (async is
 * allowed). Unknown outcomes remain pinned until a matching receipt is found.
 */
import * as NodeCrypto from "node:crypto";
import { recordValid } from "./ops-contents-slot.mjs";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const blocked = (reason) => ({ status: "BLOCKED", reason });
const timestamp = (value) => (text(value) ? Date.parse(value) : NaN);
const emptyCoordination = () => ({ version: 1, results: [], history: [], intent: null });

function matchingReview(receipt, result) {
  return (
    receipt?.requestId === result.review?.requestId &&
    receipt?.ownerId === result.review?.ownerId &&
    receipt?.key === result.key &&
    receipt?.headSha === result.packet.finalSha &&
    text(receipt?.evidence) &&
    ["ACCEPTED", "CHANGES_REQUIRED"].includes(receipt?.decision)
  );
}

function coordinationValid(state, record) {
  if (state?.version !== 1 || !Array.isArray(state.results) || !Array.isArray(state.history))
    return false;
  const phases = new Set([
    "REPORTED",
    "PUBLICATION_WAIT",
    "CI_WAIT",
    "BLOCKED",
    "REVIEWING",
    "ACCEPTED",
    "CHANGES_REQUIRED",
  ]);
  const seen = new Set();
  for (const result of state.results) {
    if (
      !result?.packet ||
      !text(result.comment?.id) ||
      !text(result.comment?.url) ||
      !Number.isFinite(timestamp(result.comment?.createdAt)) ||
      !sha(result.packet.finalSha) ||
      !["COMPLETED", "STOPPED"].includes(result.packet.workerState) ||
      !["code", "no_code"].includes(result.packet.classification) ||
      !Number.isInteger(result.packet.prNumber) ||
      result.packet.prNumber < 1 ||
      (result.packet.classification === "no_code" &&
        result.packet.finalSha !== result.packet.startingSha) ||
      !phases.has(result.phase) ||
      result.key !== `${result.packet.taskId}:${result.packet.finalSha}:${result.comment.id}` ||
      result.fingerprint !== digest(result.packet) ||
      seen.has(result.packet.taskId)
    )
      return false;
    seen.add(result.packet.taskId);
    const task = taskBinding(result.task);
    if (
      task.id !== result.packet.taskId ||
      task.workerId !== result.packet.workerId ||
      task.branch !== result.packet.branch ||
      task.startingSha !== result.packet.startingSha ||
      task.predecessor !== result.packet.predecessor ||
      digest(task.dependencies) !== digest(result.packet.dependencies)
    )
      return false;
    if (
      result.review !== null &&
      (!text(result.review?.ownerId) || !text(result.review?.requestId))
    )
      return false;
    if (
      ["ACCEPTED", "CHANGES_REQUIRED"].includes(result.phase) &&
      (result.packet.workerState !== "COMPLETED" ||
        !matchingReview(result.review?.receipt, result) ||
        result.review.receipt.decision !== result.phase ||
        result.ci?.status !== "completed" ||
        result.ci?.conclusion !== "success" ||
        result.ci?.headSha !== result.packet.finalSha ||
        result.ci?.workflow !== task.requiredCI.workflow ||
        result.ci?.check !== task.requiredCI.check ||
        !result.publication)
    )
      return false;
  }
  let generation = 0;
  for (const entry of state.history) {
    if (
      !Number.isInteger(entry?.generation) ||
      entry.generation <= generation ||
      entry.generation > record.generation ||
      !text(entry.action) ||
      !text(entry.taskId)
    )
      return false;
    generation = entry.generation;
  }
  if (state.intent !== null) {
    const intent = state.intent;
    const task = taskBinding(intent?.task);
    if (
      !text(intent.id) ||
      intent.id !== record.dispatchId ||
      task.id !== record.taskId ||
      task.workerId !== record.workerId ||
      !["started", "uncertain", "confirmed"].includes(intent.delivery) ||
      !state.results.some(
        (result) => result.key === intent.predecessorResultKey && result.phase === "ACCEPTED",
      ) ||
      (intent.delivery === "confirmed" && !matchingStart(intent.receipt, intent))
    )
      return false;
  }
  return true;
}

function taskBinding(task) {
  if (
    !task ||
    ![task.id, task.workerId, task.resultAuthorId, task.branch, task.baseBranch, task.scope].every(
      text,
    ) ||
    !sha(task.startingSha) ||
    !text(task.requiredCI?.workflow) ||
    !text(task.requiredCI?.check) ||
    !(task.predecessor === null || text(task.predecessor)) ||
    !Array.isArray(task.dependencies) ||
    !task.dependencies.every((dependency) => text(dependency.taskId) && sha(dependency.sha))
  )
    throw new Error("invalid-task-binding");
  return {
    id: task.id,
    workerId: task.workerId,
    resultAuthorId: task.resultAuthorId,
    branch: task.branch,
    baseBranch: task.baseBranch,
    scope: task.scope,
    startingSha: task.startingSha,
    requiredCI: { workflow: task.requiredCI.workflow, check: task.requiredCI.check },
    predecessor: task.predecessor,
    dependencies: task.dependencies.map(({ taskId, sha: commit }) => ({ taskId, sha: commit })),
  };
}

async function read(remote) {
  const snapshot = await remote.read();
  if (snapshot.status !== "ok" || !text(snapshot.blobSha) || !recordValid(snapshot.record)) {
    throw new Error("invalid-or-missing-slot");
  }
  const state = snapshot.record.coordination;
  if (state !== undefined && !coordinationValid(state, snapshot.record))
    throw new Error("invalid-coordination-state");
  return snapshot;
}

async function transition(remote, snapshot, action, change) {
  const record = structuredClone(snapshot.record);
  record.coordination ??= emptyCoordination();
  change(record, record.coordination);
  record.generation += 1;
  record.nonce = NodeCrypto.randomUUID();
  record.coordination.history.push({
    generation: record.generation,
    action,
    taskId: record.taskId,
    dispatchId: record.dispatchId,
    resultKey:
      record.coordination.results.find((result) => result.packet.taskId === record.taskId)?.key ??
      null,
    ...(["successor-reserved", "dispatch-confirmed", "dispatch-uncertain"].includes(action)
      ? { intent: structuredClone(record.coordination.intent) }
      : {}),
  });
  if (!recordValid(record) || !coordinationValid(record.coordination, record))
    throw new Error("invalid-transition");
  const result = await remote.compareAndSwap({ expectedBlobSha: snapshot.blobSha, record });
  if (!result.ok) return null;
  return { status: "ok", blobSha: result.blobSha, record };
}

async function pages(fetchPage) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  do {
    if (seen.has(cursor)) throw new Error("pagination-cycle");
    seen.add(cursor);
    const page = await fetchPage(cursor);
    if (!Array.isArray(page.items) || !(page.nextCursor === null || text(page.nextCursor))) {
      throw new Error("invalid-page");
    }
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

async function discover(github, task) {
  const prs = await pages((cursor) => github.listPullRequests({ cursor }));
  const candidates = [];
  for (const pr of prs) {
    const comments = await pages((cursor) => github.listComments({ prNumber: pr.number, cursor }));
    for (const comment of comments) {
      let packet;
      try {
        packet = JSON.parse(comment.body);
      } catch {
        continue;
      }
      if (packet?.kind !== "implementation_result" || packet.taskId !== task.id) continue;
      if (
        comment.authorId !== task.resultAuthorId ||
        !text(comment.id) ||
        !text(comment.url) ||
        !Number.isFinite(timestamp(comment.createdAt)) ||
        packet.workerId !== task.workerId ||
        packet.branch !== task.branch ||
        packet.startingSha !== task.startingSha ||
        !sha(packet.finalSha) ||
        !Number.isInteger(packet.prNumber) ||
        packet.prNumber < 1 ||
        !["COMPLETED", "STOPPED"].includes(packet.workerState) ||
        !["code", "no_code"].includes(packet.classification) ||
        packet.predecessor !== task.predecessor ||
        !Array.isArray(packet.dependencies) ||
        packet.dependencies.length !== task.dependencies.length ||
        !packet.dependencies.every(
          (dependency, index) =>
            dependency?.taskId === task.dependencies[index].taskId &&
            dependency?.sha === task.dependencies[index].sha,
        ) ||
        (packet.classification === "no_code" && packet.finalSha !== packet.startingSha)
      )
        throw new Error("invalid-result-binding");
      const normalized = {
        taskId: task.id,
        workerId: task.workerId,
        branch: task.branch,
        startingSha: task.startingSha,
        finalSha: packet.finalSha,
        prNumber: packet.prNumber,
        workerState: packet.workerState,
        classification: packet.classification,
        predecessor: task.predecessor,
        dependencies: task.dependencies,
      };
      candidates.push({
        packet: normalized,
        fingerprint: digest(normalized),
        comment: { id: comment.id, url: comment.url, createdAt: comment.createdAt },
      });
    }
  }
  candidates.sort(
    (a, b) =>
      timestamp(a.comment.createdAt) - timestamp(b.comment.createdAt) ||
      a.comment.id.localeCompare(b.comment.id),
  );
  if (new Set(candidates.map((candidate) => candidate.fingerprint)).size > 1) {
    throw new Error("conflicting-results");
  }
  return candidates[0];
}

async function revalidateResult(github, result) {
  const current = await discover(github, result.task);
  if (
    !current ||
    current.fingerprint !== result.fingerprint ||
    digest(current.comment) !== digest(result.comment)
  )
    throw new Error("changed-result-binding");
}

function dependenciesAccepted(task, state) {
  return task.dependencies.every((dependency) =>
    state.results.some(
      (result) =>
        result.phase === "ACCEPTED" &&
        result.packet.taskId === dependency.taskId &&
        result.packet.finalSha === dependency.sha,
    ),
  );
}

async function verification(github, result, task) {
  const { packet, comment } = result;
  const pr = await github.getPullRequest(packet.prNumber);
  if (pr === null) return { status: "PUBLICATION_WAIT" };
  if (
    pr.number !== packet.prNumber ||
    pr.branch !== task.branch ||
    pr.baseBranch !== task.baseBranch ||
    !sha(pr.baseSha)
  ) {
    return blocked("pr-binding-mismatch");
  }
  const publication = await github.getPublication({ branch: task.branch, sha: packet.finalSha });
  if (publication === null) return { status: "PUBLICATION_WAIT" };
  if (
    pr.headSha !== packet.finalSha ||
    publication.sha !== packet.finalSha ||
    publication.branch !== task.branch ||
    !Number.isFinite(timestamp(publication.firstPublishedAt))
  )
    return blocked("published-sha-mismatch");
  if (
    packet.classification === "code" &&
    timestamp(comment.createdAt) > timestamp(publication.firstPublishedAt)
  ) {
    return blocked("result-not-before-publication");
  }
  const ci = await github.getCI({ prNumber: pr.number, headSha: packet.finalSha });
  if (ci === null) return { status: "CI_WAIT", publication };
  if (ci.workflow !== task.requiredCI.workflow || ci.check !== task.requiredCI.check)
    return blocked("ci-check-mismatch");
  if (ci.headSha !== packet.finalSha || !text(ci.id) || !text(ci.url))
    return blocked("ci-head-mismatch");
  if (ci.status !== "completed") return { status: "CI_WAIT", publication, ci };
  const checkoutMatches =
    ci.checkoutSha === packet.finalSha ||
    (sha(ci.checkoutSha) &&
      ci.checkoutSha === pr.mergeSha &&
      ci.baseSha === pr.baseSha &&
      Array.isArray(ci.mergeParents) &&
      ci.mergeParents.length === 2 &&
      ci.mergeParents.includes(packet.finalSha) &&
      ci.mergeParents.includes(pr.baseSha));
  if (!checkoutMatches) return blocked("ci-checkout-mismatch");
  if (ci.conclusion !== "success") return blocked("ci-not-successful");
  return { status: "VERIFIED", publication, ci };
}

async function saveVerificationWait(remote, snapshot, result, verified) {
  const checkpoint = {
    phase: verified.status,
    reason: verified.reason ?? null,
    ci: verified.ci ?? null,
    publication: verified.publication ?? null,
  };
  if (
    Object.entries(checkpoint).some(
      ([field, value]) => digest(result[field] ?? null) !== digest(value),
    )
  ) {
    const saved = await transition(remote, snapshot, checkpoint.phase, (_record, coordination) => {
      Object.assign(
        coordination.results.find((entry) => entry.key === result.key),
        checkpoint,
      );
    });
    if (!saved) return { status: "CONFLICT" };
  }
  return verified;
}

function matchingStart(receipt, intent) {
  return (
    receipt?.dispatchId === intent.id &&
    receipt.taskId === intent.task.id &&
    receipt.workerId === intent.task.workerId &&
    receipt.startingSha === intent.task.startingSha &&
    text(receipt.url)
  );
}

async function saveReceipt(remote, snapshot, receipt) {
  const intent = snapshot.record.coordination.intent;
  if (!matchingStart(receipt, intent)) return blocked("unconfirmed-dispatch");
  const saved = await transition(remote, snapshot, "dispatch-confirmed", (record, state) => {
    record.commentUrl = receipt.url;
    record.commentDelivery = "confirmed";
    record.state = "DISPATCHED";
    state.intent.delivery = "confirmed";
    state.intent.receipt = receipt;
  });
  return { status: saved ? "DISPATCH_CONFIRMED" : "CONFLICT" };
}

async function successor({ remote, snapshot, result, tasks, worker, github }) {
  if (snapshot.record.state !== "TERMINAL") return blocked("termination-not-established");
  const state = snapshot.record.coordination;
  const choices = tasks.filter((task) => task.predecessor === result.packet.taskId);
  if (choices.length === 0) return { status: "ACCEPTED", key: result.key };
  if (choices.length !== 1) return blocked("ambiguous-successor");
  const next = choices[0];
  if (
    !dependenciesAccepted(next, state) ||
    next.startingSha !== result.packet.finalSha ||
    next.id === result.packet.taskId ||
    next.branch === result.packet.branch ||
    !next.dependencies.some(
      (dependency) =>
        dependency.taskId === result.packet.taskId && dependency.sha === result.packet.finalSha,
    )
  ) {
    return blocked("successor-dependency-mismatch");
  }
  // Re-read publication/CI after review: a review of an older head cannot start work.
  const verified = await verification(github, result, result.task);
  if (verified.status !== "VERIFIED") return verified;
  await revalidateResult(github, result);
  const intent = {
    id: NodeCrypto.randomUUID(),
    task: next,
    predecessorResultKey: result.key,
    delivery: "started",
    receipt: null,
  };
  const reserved = await transition(
    remote,
    snapshot,
    "successor-reserved",
    (record, coordination) => {
      Object.assign(record, {
        state: "DISPATCHED",
        taskId: next.id,
        workerId: next.workerId,
        dispatchId: intent.id,
        dispatchCount: 1,
        commentUrl: null,
        commentDelivery: "started",
        termination: null,
        startingSha: next.startingSha,
        branch: next.branch,
        base: next.baseBranch,
        scope: next.scope,
        predecessor: { taskId: result.packet.taskId, resultKey: result.key },
        ci: null,
        resultCheckpoint: null,
        priorResultCommentId: result.comment.id,
        dependencies: next.dependencies,
        reviewOutcome: null,
        reviewOwnership: null,
        ack: null,
        provider: null,
        acceptance: null,
        plannedPrompt: null,
      });
      coordination.intent = intent;
    },
  );
  if (!reserved) return { status: "CONFLICT" };
  try {
    return await saveReceipt(remote, reserved, await worker.start(structuredClone(intent)));
  } catch {
    await transition(remote, reserved, "dispatch-uncertain", (record, coordination) => {
      record.state = "UNCERTAIN";
      record.commentDelivery = "uncertain";
      coordination.intent.delivery = "uncertain";
    });
    return blocked("unconfirmed-dispatch");
  }
}

/** Event and periodic callers use this same one-step operation. Neither source
 * has extra authority. A reviewer receipt is an explicit technical decision,
 * not inferred from the CI conclusion. A lost review call is queried, not repeated.
 */
export async function reconcile({ source, ownerId, remote, github, reviewer, worker, tasks }) {
  try {
    if (!["event", "periodic"].includes(source) || !text(ownerId))
      return blocked("invalid-entrypoint");
    const bindings = tasks.map(taskBinding);
    if (new Set(bindings.map((task) => task.id)).size !== bindings.length)
      return blocked("duplicate-task");
    let snapshot = await read(remote);
    let state = snapshot.record.coordination ?? emptyCoordination();
    const task = bindings.find((binding) => binding.id === snapshot.record.taskId);
    if (!task || task.workerId !== snapshot.record.workerId) return blocked("unknown-holder");
    if (
      (snapshot.record.startingSha !== undefined &&
        snapshot.record.startingSha !== task.startingSha) ||
      (snapshot.record.branch !== undefined && snapshot.record.branch !== task.branch) ||
      (snapshot.record.scope !== undefined && snapshot.record.scope !== task.scope)
    )
      return blocked("slot-task-mismatch");
    if (state.intent !== null && digest(state.intent.task) !== digest(task))
      return blocked("changed-dispatch-binding");
    if (state.intent?.task.id === task.id && state.intent.delivery !== "confirmed") {
      if (
        digest(state.intent.task) !== digest(task) ||
        snapshot.record.dispatchId !== state.intent.id
      )
        return blocked("changed-dispatch-binding");
      return await saveReceipt(remote, snapshot, await worker.findStart(state.intent.id));
    }
    const candidate = await discover(github, task);
    if (!candidate) return { status: "NO_RESULT", reason: "termination-unobserved" };
    let result = state.results.find((entry) => entry.packet.taskId === task.id);
    if (
      result &&
      (result.fingerprint !== candidate.fingerprint || digest(result.task) !== digest(task))
    ) {
      return blocked("changed-result-binding");
    }
    if (!result) {
      result = {
        ...candidate,
        task,
        key: `${task.id}:${candidate.packet.finalSha}:${candidate.comment.id}`,
        phase: "REPORTED",
        review: null,
        ci: null,
        publication: null,
      };
      snapshot = await transition(remote, snapshot, "result-observed", (_record, coordination) =>
        coordination.results.push(result),
      );
      if (!snapshot) return { status: "CONFLICT" };
      state = snapshot.record.coordination;
    }
    if (result.phase === "ACCEPTED")
      return await successor({ remote, snapshot, result, tasks: bindings, worker, github });
    if (result.phase === "CHANGES_REQUIRED") return { status: "CHANGES_REQUIRED", key: result.key };
    if (result.packet.workerState !== "COMPLETED") return blocked("worker-stopped");
    if (!dependenciesAccepted(task, state)) return blocked("dependency-not-accepted");
    const verified = await verification(github, result, task);
    if (verified.status !== "VERIFIED")
      return await saveVerificationWait(remote, snapshot, result, verified);
    let receipt;
    if (result.review === null) {
      const review = { ownerId, requestId: NodeCrypto.randomUUID() };
      snapshot = await transition(remote, snapshot, "review-owned", (_record, coordination) => {
        Object.assign(
          coordination.results.find((entry) => entry.key === result.key),
          {
            phase: "REVIEWING",
            review,
            ci: verified.ci,
            publication: verified.publication,
          },
        );
      });
      if (!snapshot) return { status: "CONFLICT" };
      result = snapshot.record.coordination.results.find((entry) => entry.key === result.key);
      receipt = await reviewer.review({
        ...review,
        key: result.key,
        packet: result.packet,
        ci: verified.ci,
      });
    } else {
      receipt = await reviewer.findReview(result.review.requestId);
    }
    if (!receipt) return { status: "REVIEW_WAIT", key: result.key };
    if (!matchingReview(receipt, result)) return blocked("invalid-review-receipt");
    // Review and receipt lookup can outlive the evidence observed before them.
    // Every decision, including a terminal task with no successor, uses fresh evidence.
    const reviewedEvidence = await verification(github, result, task);
    await revalidateResult(github, result);
    if (reviewedEvidence.status !== "VERIFIED")
      return await saveVerificationWait(remote, snapshot, result, reviewedEvidence);
    snapshot = await transition(remote, snapshot, "review-recorded", (record, coordination) => {
      const entry = coordination.results.find((item) => item.key === result.key);
      entry.phase = receipt.decision;
      entry.review.receipt = receipt;
      entry.ci = reviewedEvidence.ci;
      entry.publication = reviewedEvidence.publication;
      entry.reason = null;
      if (receipt.decision === "ACCEPTED") {
        record.state = "TERMINAL";
        record.termination = {
          established: true,
          workerState: "COMPLETED",
          evidence: result.comment.url,
        };
      }
    });
    if (!snapshot) return { status: "CONFLICT" };
    if (receipt.decision !== "ACCEPTED") return { status: "CHANGES_REQUIRED", key: result.key };
    result = snapshot.record.coordination.results.find((entry) => entry.key === result.key);
    return await successor({ remote, snapshot, result, tasks: bindings, worker, github });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "adapter-failure");
  }
}
