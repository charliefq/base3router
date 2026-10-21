// @effect-diagnostics nodeBuiltinImport:off
import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

type ServerManifest = {
  name: string;
  version: string;
  license: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
};

/** The emitted bundle includes ordinary JS dependencies; only disk-backed externals install. */
export function createPortableNodeManifest(
  source: ServerManifest,
  catalog: Record<string, string>,
) {
  const dependencies = selectCliRuntimeExternalDependencies(
    resolveCatalogDependencies(source.dependencies, catalog, "apps/server"),
  );
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!/^[~^]?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec))
      throw new Error(
        `Portable Node dependency ${name} requires a registry version, received ${spec}`,
      );
  }
  return {
    name: source.name,
    version: source.version,
    license: source.license,
    type: "module",
    bin: source.bin,
    engines: source.engines,
    files: ["dist", "patches", "pnpm-workspace.yaml", "README.md"],
    dependencies,
  };
}

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";
const InstalledManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeCandidateName = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
);
const decodeInstalledManifest = Schema.decodeUnknownSync(Schema.fromJsonString(InstalledManifest));

/** Resolve without loading SDKs/binaries; reject every dependency or symlink escaping the tree. */
export function inspectInstalledNodePackage(root: string) {
  const canonicalRoot = NodeFS.realpathSync(root);
  if (canonicalRoot !== NodePath.resolve(root))
    throw Error("Installed package root must not be a symlink");
  const inside = (path: string) => {
    const actual = NodeFS.realpathSync(path);
    if (!actual.startsWith(canonicalRoot + NodePath.sep))
      throw Error(`Installed dependency escapes its tree: ${path}`);
    return actual;
  };
  for (const entry of NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) inside(NodePath.join(entry.parentPath, entry.name));
  }
  const resolutions: { name: string; version: string; path: string }[] = [];
  const visited = new Set<string>();
  const walk = (manifestPath: string) => {
    inside(manifestPath);
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const manifest = decodeInstalledManifest(NodeFS.readFileSync(manifestPath, "utf8"));
    resolutions.push({ name: manifest.name, version: manifest.version, path: manifestPath });
    const require = NodeModule.createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      let location = inside(require.resolve(name));
      while (NodePath.dirname(location) !== location) {
        const candidate = NodePath.join(location, "package.json");
        if (NodeFS.existsSync(candidate)) {
          const dependency = decodeCandidateName(NodeFS.readFileSync(candidate, "utf8"));
          if (dependency.name === name) {
            walk(candidate);
            break;
          }
        }
        location = NodePath.dirname(location);
      }
      if (NodePath.dirname(location) === location)
        throw Error(`Cannot locate installed manifest: ${name}`);
    }
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const candidate = (require.resolve.paths(name) ?? [])
        .map((directory) => NodePath.join(directory, name, "package.json"))
        .find((path) => NodeFS.existsSync(path));
      // Unsupported platform variants need not be installed; present variants
      // and all of their mandatory dependencies must still belong to this tree.
      if (candidate) walk(inside(candidate));
    }
  };
  walk(NodePath.join(root, "package.json"));
  return {
    root: canonicalRoot,
    resolutions,
    repositoryFallback: false,
    inspection: "resolution only; no provider SDK operation",
  };
}

/** This bounded delivery emits only the target verified by its clean-install journey. */
export function resolvePortableNodeTarget(
  hostPlatform: string,
  hostArch: string,
  glibcVersionRuntime?: string,
) {
  if (hostPlatform !== "linux" || hostArch !== "x64")
    throw Error(
      "Portable Node delivery supports Linux x64/glibc only; no Windows, macOS or ARM artifact is verified",
    );
  if (!glibcVersionRuntime || !/^\d+\.\d+(?:\.\d+)?$/.test(glibcVersionRuntime))
    throw Error(
      "Portable Node delivery requires a positively reported glibc runtime; musl or unknown libc is not verified",
    );
  return { platform: "linux" as const, arch: "x64" as const, label: "linux-x64-glibc" };
}
