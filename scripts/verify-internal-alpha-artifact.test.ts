// @effect-diagnostics nodeBuiltinImport:off - Builds disposable on-disk installer payloads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  isInternalAlphaArtifactName,
  scanPathForSecrets,
  verifyInternalAlphaArtifactDirectory,
} from "./verify-internal-alpha-artifact.ts";

it("accepts Internal Alpha artifact names and rejects others", () => {
  expect(isInternalAlphaArtifactName("Base3Router-Internal-Alpha-arm64.dmg")).toBe(true);
  expect(isInternalAlphaArtifactName("T3-Code-0.0.42-arm64.dmg")).toBe(false);
});

it("flags secret-shaped files and leaves a clean payload alone", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "alpha-artifact-"));
  const clean = NodePath.join(root, "Base3Router-Internal-Alpha-x64.exe");
  const secret = NodePath.join(root, ".env");
  const nested = NodePath.join(root, "unpacked", "state.sqlite");
  NodeFS.writeFileSync(clean, "Base3Router Internal Alpha installer");
  NodeFS.writeFileSync(secret, "CURSOR_API_KEY=do-not-ship\n");
  NodeFS.mkdirSync(NodePath.dirname(nested), { recursive: true });
  NodeFS.writeFileSync(nested, "fixture-db");

  expect(scanPathForSecrets(clean)).toEqual([]);
  expect(scanPathForSecrets(secret).length).toBeGreaterThan(0);
  expect(
    scanPathForSecrets(NodePath.dirname(nested)).some((finding) =>
      finding.includes("state.sqlite"),
    ),
  ).toBe(true);

  const verified = verifyInternalAlphaArtifactDirectory(root);
  expect(verified.artifacts.map((entry) => entry.name)).toEqual([
    "Base3Router-Internal-Alpha-x64.exe",
  ]);
  expect(verified.findings.length).toBeGreaterThan(0);
});
