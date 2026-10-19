// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import source from "../../apps/server/package.json" with { type: "json" };
import { createPortableNodeManifest } from "./node-package.ts";

const catalog = {
  "@effect/platform-node": "4.0.0-rc.115",
  "@effect/platform-node-shared": "4.0.0-rc.115",
  effect: "4.0.0-rc.115",
  jose: "6.2.2",
  yaml: "2.9.0",
};
it("emits a registry-resolvable Node manifest without repository-only scripts or protocols", () => {
  const manifest = createPortableNodeManifest(source, catalog);
  assert.deepStrictEqual(manifest.dependencies, {
    "@cursor/sdk": "1.0.31",
    "@ff-labs/fff-node": "0.9.4",
    "@napi-rs/keyring": "^1.3.0",
    "node-pty": "^1.2.0-beta.15",
  });
  assert.deepStrictEqual(manifest.bin, source.bin);
  assert.isFalse("scripts" in manifest);
  assert.isFalse("devDependencies" in manifest);
  assert.notMatch(JSON.stringify(manifest), /catalog:|workspace:|file:|link:/);
});
it.each(["workspace:*", "file:../native", "link:../../node_modules/node-pty"])(
  "rejects a nonportable runtime root %s",
  (spec) => {
    assert.throws(
      () => createPortableNodeManifest({ ...source, dependencies: { "node-pty": spec } }, {}),
      /requires a registry version/,
    );
  },
);
it("resolves a catalog-backed native root with the existing resolver", () => {
  assert.deepStrictEqual(
    createPortableNodeManifest(
      { ...source, dependencies: { "node-pty": "catalog:" } },
      { "node-pty": "1.2.0-beta.15" },
    ).dependencies,
    { "node-pty": "1.2.0-beta.15" },
  );
});
it("does not invent a missing catalog version", () => {
  assert.throws(
    () => createPortableNodeManifest({ ...source, dependencies: { "node-pty": "catalog:" } }, {}),
    /Expected key/,
  );
});

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { inspectInstalledNodePackage } from "./node-package.ts";

function packageFixture(base: string, directory: string, name: string, dependencies = {}) {
  const path = NodePath.join(base, directory);
  NodeFS.mkdirSync(path, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(path, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "lib/index.cjs", dependencies }),
  );
  NodeFS.mkdirSync(NodePath.join(path, "lib"));
  NodeFS.writeFileSync(
    NodePath.join(path, "lib/package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  NodeFS.writeFileSync(
    NodePath.join(path, "lib/index.cjs"),
    "throw Error('Inspection must never load SDK code');",
  );
  return path;
}
it("resolves the full installed closure without loading SDK code or leaf type-only manifests", () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-node-package-inspect-"));
  try {
    const root = packageFixture(base, "package", "t3", { native: "1.0.0" });
    packageFixture(root, "node_modules/native", "native", { wrapper: "1.0.0" });
    packageFixture(root, "node_modules/wrapper", "wrapper");
    assert.deepStrictEqual(
      inspectInstalledNodePackage(root).resolutions.map((p) => p.name),
      ["t3", "native", "wrapper"],
    );
  } finally {
    NodeFS.rmSync(base, { recursive: true });
  }
});
it("rejects a repository-style dependency symlink outside the installed tree", () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-node-package-inspect-"));
  try {
    const root = packageFixture(base, "package", "t3", { native: "1.0.0" });
    const elsewhere = packageFixture(base, "elsewhere", "native");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
    NodeFS.symlinkSync(elsewhere, NodePath.join(root, "node_modules/native"), "junction");
    assert.throws(() => inspectInstalledNodePackage(root), /escapes its tree/);
  } finally {
    NodeFS.rmSync(base, { recursive: true });
  }
});
it("rejects Node's parent-directory fallback when a required dependency is absent locally", () => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-node-package-inspect-"));
  try {
    const root = packageFixture(base, "package", "t3", { native: "1.0.0" });
    packageFixture(base, "node_modules/native", "native");
    assert.throws(() => inspectInstalledNodePackage(root), /escapes its tree/);
  } finally {
    NodeFS.rmSync(base, { recursive: true });
  }
});
