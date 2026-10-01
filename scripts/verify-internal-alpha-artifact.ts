// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Host-side artifact scan runs before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const FORBIDDEN_NAMES = [
  ".env",
  ".env.local",
  "state.sqlite",
  "state.sqlite-wal",
  "state.sqlite-shm",
];
const FORBIDDEN_CONTENT = [
  /CURSOR_API_KEY\s*=/i,
  /ANTHROPIC_API_KEY\s*=/i,
  /OPENAI_API_KEY\s*=/i,
  /Authorization:\s*Bearer\s+\S+/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
];

export const INTERNAL_ALPHA_ARTIFACT_PREFIX = "Base3Router-Internal-Alpha";

export function isInternalAlphaArtifactName(fileName: string): boolean {
  return fileName.startsWith(INTERNAL_ALPHA_ARTIFACT_PREFIX);
}

export function scanPathForSecrets(filePath: string): string[] {
  const base = NodePath.basename(filePath);
  if (FORBIDDEN_NAMES.includes(base)) {
    return [`forbidden filename ${base}`];
  }
  const stats = NodeFS.statSync(filePath);
  if (stats.isDirectory()) {
    return NodeFS.readdirSync(filePath).flatMap((entry) =>
      scanPathForSecrets(NodePath.join(filePath, entry)),
    );
  }
  if (!stats.isFile() || stats.size > 32 * 1024 * 1024) {
    return [];
  }
  let text = "";
  try {
    text = NodeFS.readFileSync(filePath, "latin1");
  } catch {
    return [];
  }
  return FORBIDDEN_CONTENT.flatMap((pattern) =>
    pattern.test(text) ? [`forbidden content ${pattern}`] : [],
  );
}

export function hashFile(filePath: string): string {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NodeFS.readFileSync(filePath));
  return hash.digest("hex");
}

export function verifyInternalAlphaArtifactDirectory(directory: string): {
  readonly artifacts: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
  readonly findings: ReadonlyArray<string>;
} {
  const entries = NodeFS.readdirSync(directory, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.isFile() && isInternalAlphaArtifactName(entry.name))
    .map((entry) => {
      const filePath = NodePath.join(directory, entry.name);
      return { name: entry.name, sha256: hashFile(filePath) };
    });
  const findings = entries.flatMap((entry) =>
    scanPathForSecrets(NodePath.join(directory, entry.name)),
  );
  return { artifacts, findings };
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) {
    process.stderr.write("usage: verify-internal-alpha-artifact.ts <directory>\n");
    process.exit(1);
  }
  const result = verifyInternalAlphaArtifactDirectory(directory);
  if (result.artifacts.length === 0) {
    process.stderr.write(`no ${INTERNAL_ALPHA_ARTIFACT_PREFIX} artifacts in ${directory}\n`);
    process.exit(1);
  }
  const sums = result.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  NodeFS.writeFileSync(NodePath.join(directory, "SHA256SUMS"), `${sums}\n`);
  for (const artifact of result.artifacts) {
    if (!artifact.name.includes("Base3Router")) {
      process.stderr.write(`artifact is missing Base3Router in the filename: ${artifact.name}\n`);
      process.exit(1);
    }
    process.stdout.write(`${artifact.name} ${artifact.sha256}\n`);
  }
  if (result.findings.length > 0) {
    process.stderr.write(`${result.findings.join("\n")}\n`);
    process.exit(1);
  }
}
