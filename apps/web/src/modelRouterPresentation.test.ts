import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  presentModelRouterFallbackLabel,
  presentModelRouterWhy,
  resolveComposerModelRoutingMode,
  routeComposerModel,
  routedModelSelection,
} from "./modelRouterPresentation";

const provider = (instanceId: string, models: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId === "claude" ? "claudeAgent" : instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: models.map((model) => ({
    slug: model,
    name: model,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

describe("composer model routing presentation", () => {
  it("defaults to Auto Route unless the user picked a model", () => {
    expect(resolveComposerModelRoutingMode({})).toBe("auto");
    expect(resolveComposerModelRoutingMode({ modelSelectionExplicit: true })).toBe("manual");
  });

  it("routes Auto to an eligible catalog model", () => {
    const decision = routeComposerModel({
      mode: "auto",
      providers: [provider("codex", ["gpt-5.4"]), provider("claude", ["claude-sonnet-4-6"])],
    });
    expect(decision.selected?.target.model).toBe("gpt-5.4");
    const fallback = {
      instanceId: ProviderInstanceId.make("cursor"),
      model: "auto",
    };
    expect(routedModelSelection(decision, fallback).model).toBe("gpt-5.4");
  });

  it("explains Auto Route fallbacks without inventing metrics", () => {
    const decision = routeComposerModel({
      mode: "auto",
      providers: [provider("codex", ["gpt-5.4"]), provider("claude", ["claude-sonnet-4-6"])],
    });
    expect(presentModelRouterWhy(decision)).toContain("Auto Route selected");
    expect(presentModelRouterFallbackLabel(decision)).toBe("1 fallback");
    expect(JSON.stringify(decision)).not.toContain("sk-");
  });
});
