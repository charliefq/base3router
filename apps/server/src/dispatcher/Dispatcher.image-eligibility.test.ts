import { describe, expect, it } from "vite-plus/test";
import {
  HYBRID_ROUTER_POLICY_VERSION,
  DEFAULT_HYBRID_ROUTER_WEIGHTS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderModel,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { emptyLocalEvidence } from "@t3tools/shared/hybridRouter";
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { calculateDispatcherModelRoute } from "./Dispatcher.ts";

const provider = (id: string, modalities?: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: id,
      name: "vision-brand-image",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
    },
  ],
});
const image = {
  type: "image",
  id: "original-id",
  name: "/private/secret.png",
  mimeType: "image/png",
  sizeBytes: 1,
};
const providers = [
  provider("a-unknown"),
  provider("b-text", ["text"]),
  provider("c-image", ["text", "image"]),
];
const calculate = (input: Partial<Parameters<typeof calculateDispatcherModelRoute>[0]> = {}) =>
  calculateDispatcherModelRoute({
    mode: "auto",
    providers,
    preferredTargets: [],
    nowMs: 0,
    localTaskProfile: classifyLocalTask(""),
    ...input,
  });

describe("typed image hard eligibility", () => {
  it.each([
    { name: "image only", message: { attachments: [image] }, required: true },
    { name: "mixed", message: { attachments: [image, { type: "file" }] }, required: true },
    {
      name: "malformed typed image stays conservative",
      message: { attachments: [{ type: "image" }] },
      required: true,
    },
    {
      name: "nonimage mime and names are not evidence",
      message: { attachments: [{ type: "file", mimeType: "image/png" }] },
      required: false,
    },
    {
      name: "forward-compatible",
      message: { attachments: [null, 1, {}, { type: "future", mimeType: "image/png" }] },
      required: false,
    },
    {
      name: "context image",
      message: { context: { records: [{ kind: "image" }] } },
      required: true,
    },
    { name: "text preview", message: undefined, required: false },
  ])("$name", ({ message, required }) => {
    const decision = calculate(message === undefined ? {} : { message }).decision;
    expect(decision.task.requiredCapabilities).toEqual(required ? ["vision"] : []);
    expect(decision.selected?.target.model).toBe(required ? "c-image" : "a-unknown");
    expect(JSON.stringify(decision)).not.toContain("/private/");
    expect(JSON.stringify(decision)).not.toContain("original-id");
  });
  it.each([
    undefined,
    { requiredCapabilities: [] },
    { allowedModels: [] },
    { allowedModels: ["c-image"], excludedModels: ["c-image"] },
  ])("cannot erase image requirement with constraints %j", (constraints) => {
    const decision = calculate({
      message: { attachments: [image] },
      ...(constraints === undefined ? {} : { constraints }),
    }).decision;
    expect(decision.task.requiredCapabilities).toEqual(["vision"]);
    expect(decision.selected?.target.model ?? null).toBe(
      constraints && "allowedModels" in constraints ? null : "c-image",
    );
  });
  it.each([
    provider("unknown"),
    provider("text", ["text"]),
    provider("empty", []),
    { ...provider("image", ["image"]), availability: "unavailable" as const },
  ])("denies without capable available target", (p) => {
    const decision = calculate({ providers: [p], message: { attachments: [image] } }).decision;
    expect(decision.selected).toBeNull();
    expect(decision.fallbacks).toEqual([]);
  });
  it("legacy metadata decodes as unknown and preserves future modalities", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderModel);
    expect(decode(providers[0]!.models[0]).inputModalities).toBeUndefined();
    expect(
      decode({ ...providers[0]!.models[0], inputModalities: ["text", "future"] }).inputModalities,
    ).toEqual(["text", "future"]);
  });
  it("manual behavior stays unchanged unless explicit constraints require vision", () => {
    const preferredModelSelection = { instanceId: providers[0]!.instanceId, model: "a-unknown" };
    expect(
      calculate({ mode: "manual", preferredModelSelection, message: { attachments: [image] } })
        .manualConstraintReasons,
    ).toEqual([]);
    expect(
      calculate({
        mode: "manual",
        preferredModelSelection,
        constraints: { requiredCapabilities: ["vision"] },
      }).manualConstraintReasons,
    ).toContain("REQUIRED_CAPABILITY_MISSING");
  });
});

it.each(["active", "shadow", "load-failure"] as const)(
  "%s retains hard image eligibility and eligible fallbacks",
  (policyMode) => {
    const ps = [...providers, provider("d-image", ["image"])];
    const evidenceByTarget = new Map(
      ps.map((p, i) => [
        `${p.instanceId}\u0000${p.models[0]!.slug}`,
        {
          ...emptyLocalEvidence(),
          successTrials: 24,
          successCount: i === 0 ? 24 : 12,
          latencySamples: Array(24).fill(10) as number[],
          costSamples: Array(24).fill(0.02) as number[],
          costProvenance: "observed" as const,
          costSource: "openrouter_accounting" as const,
        },
      ]),
    );
    const hybrid = {
      activePolicyVersion: HYBRID_ROUTER_POLICY_VERSION,
      challengerEnabled: policyMode === "active",
      evidenceByTarget,
      ...(policyMode === "load-failure" ? { policyLoadFailure: "Fixture unavailable" } : {}),
      ...(policyMode === "shadow"
        ? {
            shadowPolicy: {
              policyVersion: HYBRID_ROUTER_POLICY_VERSION,
              weights: DEFAULT_HYBRID_ROUTER_WEIGHTS,
              shrinkageK: 5,
              minSampleRate: 0.5,
              evidenceByTarget,
            },
          }
        : {}),
    };
    const result = calculate({ providers: ps, message: { attachments: [image] }, hybrid });
    expect(result.decision.selected?.capabilities).toContain("vision");
    expect(result.decision.fallbacks.map((c) => c.target.model)).toEqual(["d-image"]);
    expect(result.decision.task.requiredCapabilities).toEqual(["vision"]);
    expect(
      result.decision.candidates
        .filter((c) => c.eligible)
        .map((c) => c.target.model)
        .sort(),
    ).toEqual(["c-image", "d-image"]);
  },
);
