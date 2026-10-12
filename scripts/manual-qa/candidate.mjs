import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

export const CANDIDATE_SHA = "65c0702a09b093cb8ab5b124f15665ae6d744a7d";
export const DEFAULT_BASE_NAME = "qa-65c0702a-local";
export const TOOL_REVISION = "integrated-65c0702a-v1";
export const TOOLKIT_SHA256 = "ebf12bcb36200be4fdd202481dbcd8a631737b29b24a3b61b914954debd5dc89";
const files = [
  "prepare.mjs",
  "start.mjs",
  "seed.mjs",
  "health.mjs",
  "safety.mjs",
  "qa-provider.mjs",
];

export function validateToolkit(
  directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
) {
  const hash = NodeCrypto.createHash("sha256");
  for (const name of files) {
    const path = NodePath.join(directory, name);
    if (!NodeFS.lstatSync(path).isFile() || NodeFS.lstatSync(path).isSymbolicLink())
      throw Error("Use one complete archived QA tool commit; runtime files must be regular files.");
    hash.update(name).update("\0").update(NodeFS.readFileSync(path)).update("\0");
  }
  if (hash.digest("hex") !== TOOLKIT_SHA256)
    throw Error(
      "QA tool copies are mixed or changed; archive the exact reviewed tool commit again.",
    );
}

export function validateCandidate(repo) {
  const head = NodeChildProcess.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== CANDIDATE_SHA) throw Error("Use the exact fixed integrated QA candidate.");
}

export function validateManifest(repo, base) {
  validateCandidate(repo);
  const path = NodePath.join(base, "qa-public.json");
  if (!NodeFS.lstatSync(path).isFile() || NodeFS.lstatSync(path).isSymbolicLink())
    throw Error("QA manifest must be a regular file.");
  const manifest = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  validateManifestRecord(manifest, repo, base);
}

export function validateManifestRecord(manifest, repo, base) {
  if (
    manifest.head !== CANDIDATE_SHA ||
    manifest.toolRevision !== TOOL_REVISION ||
    manifest.toolkitSha256 !== TOOLKIT_SHA256 ||
    manifest.repo !== repo ||
    manifest.base !== base ||
    manifest.manifestVersion !== 2
  )
    throw Error(
      "QA manifest belongs to an old candidate/tool or another base; prepare a fresh isolated base.",
    );
}
