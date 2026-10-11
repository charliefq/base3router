/**
 * Contents API transitions for the one repository execution slot.
 *
 * The caller injects a remote. This file does not call GitHub and does not
 * read credentials. The live branch `ops/base3-execution-slot` is not this
 * object. A mock can prove two readers of one blob SHA. A live HTTP 409 from
 * a stale blob SHA is a different check and is not repeated here.
 *
 * The @cursor dispatch comment is the provider start. The slot moves to
 * DISPATCHED before that comment is posted. A failed or ambiguous post does
 * not post again. An existing branch with a missing or unreadable file stays
 * blocked. Nothing expires.
 */
import * as NodeCrypto from "node:crypto";

const occupiedState = (record) =>
  record !== null && record !== undefined && record.state !== "TERMINAL";

const nextIdentity = (current) => ({
  schema: 1,
  generation: (current?.generation ?? 0) + 1,
  nonce: NodeCrypto.randomBytes(8).toString("hex"),
});

const hashBytes = (bytes) => NodeCrypto.createHash("sha1").update(bytes).digest("hex");

export const createMockContentsRemote = ({ branchExists = false, bytes = null } = {}) => {
  let branch = branchExists;
  let file = bytes === null ? null : { bytes };

  const publish = (record) => {
    const body = `${JSON.stringify(record)}\n`;
    file = { bytes: body, blobSha: hashBytes(body) };
    return file;
  };

  return {
    read() {
      if (!branch) return { status: "absent-branch", blobSha: null, record: null };
      if (!file) return { status: "missing-file", blobSha: null, record: null };
      try {
        return {
          status: "ok",
          blobSha: file.blobSha ?? hashBytes(file.bytes),
          record: JSON.parse(file.bytes),
        };
      } catch {
        return {
          status: "unreadable",
          blobSha: file.blobSha ?? hashBytes(file.bytes),
          record: null,
        };
      }
    },
    compareAndSwap({ expectedBlobSha, record }) {
      if (!branch) {
        if (expectedBlobSha !== null) return { ok: false, status: 409 };
        branch = true;
        const written = publish(record);
        return { ok: true, status: 201, blobSha: written.blobSha, record };
      }
      if (!file) return { ok: false, status: 409, reason: "missing-file" };
      const currentSha = file.blobSha ?? hashBytes(file.bytes);
      if (currentSha !== expectedBlobSha) return { ok: false, status: 409 };
      const written = publish(record);
      return { ok: true, status: 200, blobSha: written.blobSha, record };
    },
  };
};

const blockedRead = (current) =>
  current.status === "missing-file" || current.status === "unreadable"
    ? { ok: false, reason: "blocked", occupied: true, releasable: false }
    : null;

export const checkSlot = (remote) => {
  const current = remote.read();
  const blocked = blockedRead(current);
  if (blocked) return { ...blocked, blobSha: current.blobSha ?? null };
  if (current.status === "absent-branch") {
    return {
      ok: true,
      occupied: false,
      reason: "absent-branch",
      releasable: false,
      expired: false,
    };
  }
  return {
    ok: true,
    occupied: occupiedState(current.record),
    record: current.record,
    blobSha: current.blobSha,
    releasable: false,
    expired: false,
  };
};

export const acquireSlot = ({ remote, taskId, workerId }) => {
  const current = remote.read();
  const blocked = blockedRead(current);
  if (blocked) return { ...blocked, acquired: false };
  if (current.status === "ok" && occupiedState(current.record)) {
    if (current.record.workerId === workerId && current.record.taskId === taskId) {
      return {
        ok: true,
        acquired: false,
        restart: true,
        record: current.record,
        blobSha: current.blobSha,
      };
    }
    return {
      ok: false,
      reason: "held",
      holder: current.record.workerId,
      record: current.record,
      acquired: false,
    };
  }
  const record = {
    ...nextIdentity(current.record),
    state: "CLAIMED",
    taskId,
    workerId,
    dispatchId: null,
    dispatchCount: 0,
    commentUrl: null,
    commentDelivery: null,
    termination: null,
  };
  const swapped = remote.compareAndSwap({
    expectedBlobSha: current.status === "absent-branch" ? null : current.blobSha,
    record,
  });
  if (!swapped.ok) {
    const raced = remote.read();
    if (
      raced.record &&
      raced.record.workerId === workerId &&
      raced.record.taskId === taskId &&
      occupiedState(raced.record)
    ) {
      return {
        ok: true,
        acquired: false,
        restart: true,
        record: raced.record,
        blobSha: raced.blobSha,
      };
    }
    return {
      ok: false,
      reason: "held",
      status: swapped.status,
      holder: raced.record?.workerId ?? "unknown",
      acquired: false,
    };
  }
  return { ok: true, acquired: true, restart: false, record, blobSha: swapped.blobSha };
};

const holder = (remote, workerId) => {
  const current = remote.read();
  const blocked = blockedRead(current);
  if (blocked) return { ok: false, reason: blocked.reason, current };
  if (current.status !== "ok" || !current.record) return { ok: false, reason: "missing", current };
  if (current.record.workerId !== workerId) {
    return { ok: false, reason: "not-holder", holder: current.record.workerId, current };
  }
  return { ok: true, current };
};

export const reserveDispatch = ({ remote, workerId, postComment }) => {
  const held = holder(remote, workerId);
  if (!held.ok) return { ok: false, reason: held.reason, posted: false };
  const { current } = held;
  if (current.record.state === "DISPATCHED" || current.record.state === "UNCERTAIN") {
    return {
      ok: true,
      posted: false,
      uncertain: current.record.state === "UNCERTAIN",
      dispatchId: current.record.dispatchId,
      record: current.record,
    };
  }
  if (current.record.state !== "CLAIMED") {
    return { ok: false, reason: "not-ready", posted: false, record: current.record };
  }
  const dispatchId = `${workerId}:${current.record.taskId}:1`;
  const reserved = {
    ...current.record,
    ...nextIdentity(current.record),
    state: "DISPATCHED",
    dispatchId,
    dispatchCount: 1,
    commentUrl: null,
    commentDelivery: "started",
  };
  const swapped = remote.compareAndSwap({ expectedBlobSha: current.blobSha, record: reserved });
  if (!swapped.ok) {
    const raced = remote.read();
    if (raced.record?.state === "DISPATCHED" || raced.record?.state === "UNCERTAIN") {
      return { ok: true, posted: false, dispatchId: raced.record.dispatchId, record: raced.record };
    }
    return { ok: false, reason: "conflict", status: swapped.status, posted: false };
  }
  let commentUrl;
  try {
    commentUrl = postComment(dispatchId);
  } catch (error) {
    if (!error || error.uncertain !== true) throw error;
    const uncertain = {
      ...reserved,
      ...nextIdentity(reserved),
      state: "UNCERTAIN",
      commentDelivery: "uncertain",
    };
    remote.compareAndSwap({ expectedBlobSha: swapped.blobSha, record: uncertain });
    return { ok: true, posted: false, uncertain: true, dispatchId, record: uncertain };
  }
  const confirmed = {
    ...reserved,
    ...nextIdentity(reserved),
    commentUrl,
    commentDelivery: "confirmed",
  };
  const written = remote.compareAndSwap({ expectedBlobSha: swapped.blobSha, record: confirmed });
  return {
    ok: true,
    posted: true,
    dispatchId,
    record: written.ok ? confirmed : reserved,
    blobSha: written.ok ? written.blobSha : swapped.blobSha,
  };
};

const terminationEstablished = (termination) =>
  termination !== null &&
  termination !== undefined &&
  termination.established === true &&
  typeof termination.evidence === "string" &&
  termination.evidence.trim().length > 0 &&
  (termination.workerState === "COMPLETED" || termination.workerState === "STOPPED");

export const finishSlot = ({ remote, workerId, termination, maxAgeMs }) => {
  if (maxAgeMs !== undefined)
    return { ok: false, reason: "expiry-not-supported", redispatched: false };
  if (!terminationEstablished(termination)) {
    return { ok: false, reason: "termination-not-established", redispatched: false };
  }
  const held = holder(remote, workerId);
  if (!held.ok) return { ok: false, reason: held.reason, redispatched: false };
  const { current } = held;
  if (current.record.state === "TERMINAL") {
    return { ok: true, redispatched: false, record: current.record, blobSha: current.blobSha };
  }
  const next = {
    ...current.record,
    ...nextIdentity(current.record),
    state: "TERMINAL",
    termination: {
      established: true,
      evidence: termination.evidence,
      workerState: termination.workerState,
    },
  };
  const swapped = remote.compareAndSwap({ expectedBlobSha: current.blobSha, record: next });
  if (!swapped.ok)
    return { ok: false, reason: "conflict", status: swapped.status, redispatched: false };
  return { ok: true, redispatched: false, record: next, blobSha: swapped.blobSha };
};
