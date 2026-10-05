// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  checkEvidence,
  EVIDENCE_SCHEMA_VERSION,
  GATES,
  argvFor,
  type EvidenceDocument,
  type GateEvidence,
} from "./internal-beta-acceptance-lib.ts";

const passingGates = (): GateEvidence[] =>
  GATES.map((gate) => {
    const mapped = argvFor(gate.command, "/workspace");
    return {
      id: gate.id,
      requirementIds: [...gate.requirementIds],
      title: gate.title,
      requiredLocal: gate.requiredLocal,
      status: gate.requiredLocal ? "PASS" : "BLOCKED",
      argv: "argv" in mapped ? [...mapped.argv] : [],
      exitCode: gate.requiredLocal ? 0 : null,
      evidencePath: null,
      detail: gate.requiredLocal ? "ok" : "external",
    };
  });

const validDocument = (overrides: Partial<EvidenceDocument> = {}): EvidenceDocument => ({
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  sha: "abc123",
  dirty: false,
  recordedAt: "2026-10-04T00:00:00.000Z",
  gates: passingGates(),
  verdict: "LOCAL_STABILIZATION_VERIFIED",
  ...overrides,
});

it("does not extract commands from Markdown", () => {
  const mapped = argvFor(
    { kind: "vp-test", files: ["apps/server/src/actionGate/ActionGateService.test.ts"] },
    "/workspace",
  );
  expect("argv" in mapped).toBe(true);
  if ("argv" in mapped) {
    expect(mapped.argv[0]).toBe("vp");
    expect(mapped.argv.includes("test")).toBe(true);
  }
});

it("rejects missing evidence", () => {
  const checked = checkEvidence({ evidence: null, currentSha: "abc123", dirty: false });
  expect(checked.ok).toBe(false);
  expect(checked.verdict).toBe("STABILIZATION_BLOCKED");
  expect(checked.detail).toContain("missing");
});

it("rejects stale evidence for a different SHA", () => {
  const checked = checkEvidence({
    evidence: validDocument({ sha: "old" }),
    currentSha: "abc123",
    dirty: false,
  });
  expect(checked.ok).toBe(false);
  expect(checked.detail).toContain("does not match tree");
});

it("rejects failed required local gates even when the document claims verified", () => {
  const gates = passingGates().map((gate) =>
    gate.id === "L-lease-terminal" ? { ...gate, status: "FAIL" as const } : gate,
  );
  const checked = checkEvidence({
    evidence: validDocument({ gates, verdict: "LOCAL_STABILIZATION_VERIFIED" }),
    currentSha: "abc123",
    dirty: false,
  });
  expect(checked.ok).toBe(false);
  expect(checked.detail).toContain("L-lease-terminal");
});

it("rejects evidence that omits a required local gate", () => {
  const checked = checkEvidence({
    evidence: validDocument({ gates: passingGates().filter((gate) => gate.id !== "L-mcp-ask") }),
    currentSha: "abc123",
    dirty: false,
  });
  expect(checked.ok).toBe(false);
  expect(checked.detail).toContain("L-mcp-ask");
});

it("accepts valid SHA-bound evidence for the current tree", () => {
  const checked = checkEvidence({
    evidence: validDocument(),
    currentSha: "abc123",
    dirty: false,
  });
  expect(checked.ok).toBe(true);
  expect(checked.verdict).toBe("LOCAL_STABILIZATION_VERIFIED");
});

it("round-trips a fixture evidence file", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acceptance-"));
  const path = NodePath.join(dir, "evidence.json");
  NodeFS.writeFileSync(path, `${JSON.stringify(validDocument(), null, 2)}\n`);
  const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as EvidenceDocument;
  const checked = checkEvidence({ evidence: parsed, currentSha: "abc123", dirty: false });
  expect(checked.ok).toBe(true);
  NodeFS.rmSync(dir, { recursive: true, force: true });
});
