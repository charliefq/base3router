/** Isolated, cooperative local-filesystem receipt storage. No executor or live-slot access. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { recordReceipt, validateJournal } from "./ops-evidence-adapters.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (reason) => {
  throw new Error(reason);
};
const syncDirectory = (directory) => {
  const fd = NodeFS.openSync(directory, NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY);
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

function temporaryDirectory(directory) {
  if (
    typeof NodeFS.constants.O_NOFOLLOW !== "number" ||
    typeof NodeFS.constants.O_NONBLOCK !== "number" ||
    typeof NodeFS.constants.O_DIRECTORY !== "number" ||
    typeof directory !== "string" ||
    !NodePath.isAbsolute(directory)
  )
    fail("unsupported-store-platform-or-path");
  const canonical = NodeFS.realpathSync(directory);
  const relative = NodePath.relative(NodeFS.realpathSync(NodeOS.tmpdir()), canonical);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative))
    fail("store-outside-temporary-root");
  if (NodePath.resolve(directory) !== canonical) fail("symlink-store-directory");
  return canonical;
}

function encode(payload) {
  const body = JSON.stringify({ payload, digest: hash(JSON.stringify(payload)) }) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) fail("receipt-store-too-large");
  return body;
}

export function createReceiptStore({ parentDirectory, fault = () => {} }) {
  if (typeof fault !== "function") fail("invalid-fault-hook");
  const parent = temporaryDirectory(parentDirectory);
  const directory = NodeFS.mkdtempSync(NodePath.join(parent, "b3r-receipts-"));
  NodeFS.chmodSync(directory, 0o700);
  const storeId = NodeCrypto.randomUUID();
  const body = encode({ version: 1, storeId, generation: 0, journal: { version: 1, entries: [] } });
  const fd = NodeFS.openSync(NodePath.join(directory, "journal.json"), "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, body);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  syncDirectory(directory);
  syncDirectory(parent);
  return openReceiptStore({ directory, storeId, fault });
}

export function openReceiptStore({ directory, storeId, fault = () => {} }) {
  directory = temporaryDirectory(directory);
  if (
    !NodePath.basename(directory).startsWith("b3r-receipts-") ||
    !/^[a-f0-9-]{36}$/.test(storeId) ||
    typeof fault !== "function" ||
    (NodeFS.statSync(directory).mode & 0o777) !== 0o700
  )
    fail("invalid-isolated-store");
  const file = NodePath.join(directory, "journal.json");
  const lock = NodePath.join(directory, "writer.lock");
  const load = () => {
    let fd;
    try {
      fd = NodeFS.openSync(
        file,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      const stat = NodeFS.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail("invalid-store-file");
      const bytes = NodeFS.readFileSync(fd);
      const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const payload = envelope.payload;
      if (
        payload?.version !== 1 ||
        payload.storeId !== storeId ||
        !Number.isSafeInteger(payload.generation) ||
        payload.generation < 0 ||
        envelope.digest !== hash(JSON.stringify(payload))
      )
        fail("invalid-store-envelope");
      validateJournal(payload.journal);
      return { payload, token: { storeId, generation: payload.generation, digest: hash(bytes) } };
    } catch {
      fail("receipt-store-unreadable");
    } finally {
      if (fd !== undefined) NodeFS.closeSync(fd);
    }
  };
  const locked = (operation) => {
    let fd;
    try {
      fd = NodeFS.openSync(lock, "wx", 0o600);
    } catch {
      fail("receipt-store-locked-or-inaccessible");
    }
    let unsafe = false;
    try {
      NodeFS.writeFileSync(fd, JSON.stringify({ storeId, pid: process.pid }));
      NodeFS.fsyncSync(fd);
      syncDirectory(directory);
      return operation(
        () => {
          unsafe = true;
        },
        () => {
          unsafe = false;
        },
      );
    } finally {
      NodeFS.closeSync(fd);
      // Any ambiguous publication leaves the lock for independent recovery.
      // No PID/age-based stealing or automatic repair exists.
      if (!unsafe) {
        NodeFS.unlinkSync(lock);
        syncDirectory(directory);
      }
    }
  };
  const snapshot = () =>
    locked(() => {
      const current = load();
      return { token: current.token, journal: structuredClone(current.payload.journal) };
    });
  return {
    directory,
    storeId,
    snapshot,
    read: () => snapshot().journal,
    record({ expected, entry }) {
      return locked((markUnsafe, markSafe) => {
        fault("locked");
        const current = load();
        if (
          !expected ||
          Object.keys(current.token).some((key) => expected[key] !== current.token[key])
        )
          fail("receipt-cas-conflict");
        const journal = recordReceipt(current.payload.journal, entry);
        if (JSON.stringify(journal) === JSON.stringify(current.payload.journal))
          return { changed: false, token: current.token };
        if (current.payload.generation === Number.MAX_SAFE_INTEGER)
          fail("receipt-generation-exhausted");
        const body = encode({
          ...current.payload,
          generation: current.payload.generation + 1,
          journal,
        });
        const temporary = NodePath.join(directory, `write-${NodeCrypto.randomUUID()}.tmp`);
        markUnsafe();
        let output;
        try {
          output = NodeFS.openSync(temporary, "wx", 0o600);
          NodeFS.writeFileSync(output, body);
          fault("after-write");
          NodeFS.fsyncSync(output);
          fault("after-file-sync");
        } finally {
          if (output !== undefined) NodeFS.closeSync(output);
        }
        NodeFS.renameSync(temporary, file);
        fault("after-rename");
        syncDirectory(directory);
        fault("after-directory-sync");
        const result = {
          changed: true,
          token: { storeId, generation: current.payload.generation + 1, digest: hash(body) },
        };
        markSafe();
        return result;
      });
    },
  };
}
