import {
  SkillId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSkill,
  type SkillCapability,
  type SkillInstructionRef,
  type SkillInstructionTrust,
  type SkillManifestV0,
  type SkillRequiredPermission,
  type SkillRouterCandidate,
  type SkillSourceKind,
  type SkillTrustState,
  MODEL_ROUTER_UNKNOWN_METRIC,
  SKILL_MANIFEST_VERSION,
} from "@t3tools/contracts";

import { digestCanonical } from "./actionCanonical.ts";

const SECRET_SHAPED =
  /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|OPENROUTER_API_KEY\s*=|CURSOR_API_KEY\s*=|api[_-]?key\s*[=:]|Authorization\s*:/i;

export const SKILL_SECRET_REDACTION = "[redacted]";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unnamed";

const redact = (value: string): string =>
  SECRET_SHAPED.test(value) ? SKILL_SECRET_REDACTION : value;

export const makeSkillId = (
  source: SkillSourceKind,
  driver: ProviderDriverKind | null,
  name: string,
): SkillId => SkillId.make(`${source}:${driver ?? "unknown"}:${slugify(name)}`.slice(0, 128));

export const skillManifestFromProviderSkill = (input: {
  readonly skill: ServerProviderSkill;
  readonly driver: ProviderDriverKind | null;
  readonly source?: SkillSourceKind;
  readonly trustState?: SkillTrustState;
  readonly capabilities?: ReadonlyArray<SkillCapability>;
  readonly requiredPermissions?: ReadonlyArray<SkillRequiredPermission>;
  readonly instructionsTrust?: SkillInstructionTrust;
}): SkillManifestV0 => {
  const source = input.source ?? "provider-catalog";
  const name = redact(input.skill.displayName ?? input.skill.name);
  return {
    manifestVersion: SKILL_MANIFEST_VERSION,
    skillId: makeSkillId(source, input.driver, input.skill.name),
    name,
    version: "0.0.0",
    source,
    provenance: redact(input.skill.path),
    driver: input.driver,
    trustState: input.trustState ?? "unknown",
    enabled: input.skill.enabled,
    available: input.skill.enabled,
    capabilities: [...(input.capabilities ?? [])],
    compatibleTaskClasses: [],
    compatibleModelCapabilities: [],
    requiredMcpTools: [],
    riskClass: "unclassified",
    requiredPermissions: [...(input.requiredPermissions ?? [])],
    costHint: MODEL_ROUTER_UNKNOWN_METRIC,
    resourceHint: MODEL_ROUTER_UNKNOWN_METRIC,
    instructionsTrust: input.instructionsTrust ?? "not-executable",
  };
};

export const skillCatalogFromProviders = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SkillManifestV0> =>
  providers.flatMap((provider) =>
    provider.skills.map((skill) =>
      skillManifestFromProviderSkill({
        skill,
        driver: provider.driver,
        source: "provider-catalog",
      }),
    ),
  );

export const trustedSkillInstructionRef = (input: {
  readonly manifest: SkillManifestV0;
  readonly selected: SkillRouterCandidate | null;
}): SkillInstructionRef | null => {
  if (input.selected === null) return null;
  if (input.manifest.skillId !== input.selected.skillId) return null;
  if (input.manifest.trustState !== "trusted") return null;
  if (input.manifest.instructionsTrust !== "trusted-selected") return null;
  return {
    skillId: input.manifest.skillId,
    version: input.manifest.version,
    digest: digestCanonical({
      skillId: input.manifest.skillId,
      version: input.manifest.version,
    }),
  };
};

export const skillManifestOmitsSecrets = (manifest: SkillManifestV0): boolean =>
  !SECRET_SHAPED.test(JSON.stringify(manifest));
