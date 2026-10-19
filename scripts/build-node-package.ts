// @effect-diagnostics nodeBuiltinImport:off
/** Build a registry-dependent Node artifact; never installs or invokes a provider. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import source from "../apps/server/package.json" with { type: "json" };
import rootPackage from "../package.json" with { type: "json" };
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
} from "./build-desktop-artifact.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { createPortableNodeManifest, resolvePortableNodeTarget } from "./lib/node-package.ts";

const Workspace = Schema.Struct({
  catalog: Schema.Record(Schema.String, Schema.String),
  allowBuilds: Schema.Record(Schema.String, Schema.Boolean),
  patchedDependencies: Schema.Record(Schema.String, Schema.String),
  overrides: Schema.Record(Schema.String, Schema.String),
});
const decodeWorkspace = Schema.decodeEffect(fromYaml(Workspace));
const Stage = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.Literal("hoisted"),
});
const encodeStage = Schema.encodeEffect(fromYaml(Stage));
const target = resolvePortableNodeTarget(
  Effect.runSync(HostProcessPlatform),
  Effect.runSync(HostProcessArchitecture),
);
const { platform, arch } = target;
const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const index = process.argv.indexOf("--output-dir");
if (index < 0 || !process.argv[index + 1]) throw Error("Use --output-dir <new artifact directory>");
const output = NodePath.resolve(process.argv[index + 1]!);
if (NodeFS.existsSync(output)) throw Error("Refusing to overwrite an existing artifact directory");
const workspace = await Effect.runPromise(
  decodeWorkspace(NodeFS.readFileSync(NodePath.join(repo, "pnpm-workspace.yaml"), "utf8")),
);
const manifest = createPortableNodeManifest(source, workspace.catalog);
const native = resolveFffNativeDependencies(
  platform,
  arch,
  manifest.dependencies["@ff-labs/fff-node"]!,
);
const patches = createStagePatchedDependencies(
  workspace.patchedDependencies,
  manifest.dependencies,
);
const policy = {
  ...createStageWorkspaceConfig({
    platform,
    arch,
    allowBuilds: workspace.allowBuilds,
    patchedDependencies: patches,
    overrides: resolveCatalogDependencies(workspace.overrides, workspace.catalog, "apps/server"),
  }),
  nodeLinker: "hoisted" as const,
};
const stage = NodePath.join(output, "package");
NodeFS.mkdirSync(stage, { recursive: true });
NodeFS.cpSync(NodePath.join(repo, "apps/server/dist"), NodePath.join(stage, "dist"), {
  recursive: true,
});
NodeFS.writeFileSync(
  NodePath.join(stage, "package.json"),
  JSON.stringify(
    { ...manifest, packageManager: rootPackage.packageManager, optionalDependencies: native },
    null,
    2,
  ) + "\n",
);
NodeFS.writeFileSync(
  NodePath.join(stage, "pnpm-workspace.yaml"),
  await Effect.runPromise(encodeStage(policy)),
);
for (const relative of Object.values(patches)) {
  const target = NodePath.join(stage, relative);
  if (!NodePath.resolve(repo, relative).startsWith(NodePath.join(repo, "patches/")))
    throw Error("Patch must be repository-reviewed");
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.copyFileSync(NodePath.join(repo, relative), target);
}
NodeFS.writeFileSync(
  NodePath.join(stage, "README.md"),
  "# Local Node package\n\nRegistry-dependent build for " +
    target.label +
    ". Requires Node matching package.json and pnpm 11. Extract the tarball, then run `pnpm install --prod` inside package/. Its pnpm-workspace.yaml retains the reviewed native-build, patch and override policy. Start with `node dist/bin.mjs serve --base-dir <explicit-disposable-data-directory> --no-browser`. This artifact is not offline/self-contained, a desktop/mobile installer, or real-provider verification.\n",
);
const packed = NodeChildProcess.spawnSync(
  "npm",
  [
    "pack",
    "--ignore-scripts",
    "--cache",
    NodePath.join(output, ".pack-cache"),
    "--pack-destination",
    output,
  ],
  { cwd: stage, encoding: "utf8" },
);
if (packed.status !== 0) throw Error(`npm pack failed: ${packed.stderr}`);
process.stdout.write(
  JSON.stringify({
    output,
    stage,
    package: NodePath.join(output, `${manifest.name}-${manifest.version}.tgz`),
    target: target.label,
    runtimeDependencies: manifest.dependencies,
    installation: "Registry-dependent; reviewed policy included; no dependencies bundled",
  }) + "\n",
);
