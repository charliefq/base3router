import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  isProviderTaskExecutionCapable,
  isProviderTextGenerationCapable,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  modelRouterCatalogFromProviders,
  modelRouterCatalogForMode,
  routeModel,
} from "./modelRouter.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("openrouter-text"),
  driver: ProviderDriverKind.make("openrouter"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-16T00:00:00Z",
  supportsTextGeneration: false,
  supportsTextTasks: true,
  models: [
    {
      slug: "openrouter/auto",
      name: "OpenRouter Auto (remote model selection)",
      isCustom: false,
      capabilities: null,
      inputModalities: ["text"],
    },
  ],
  slashCommands: [],
  skills: [],
};
describe("OpenRouter explicit text transport", () => {
  it("permits task admission while keeping auxiliary generation disabled", () => {
    expect(isProviderTaskExecutionCapable(provider)).toBe(true);
    expect(isProviderTextGenerationCapable(provider)).toBe(false);
    expect(isProviderTaskExecutionCapable({ ...provider, supportsTextTasks: undefined })).toBe(
      false,
    );
  });
  it("never invents tools/code/vision or replaces heuristic Auto with remote Auto", () => {
    const catalog = modelRouterCatalogFromProviders([provider]);
    expect(catalog[0]?.capabilities).toEqual([]);
    expect(modelRouterCatalogForMode(catalog, "auto")).toEqual([]);
    const target = { instanceId: provider.instanceId, model: "openrouter/auto" };
    for (const capability of ["vision", "tools", "code"] as const) {
      const decision = routeModel({
        mode: "manual",
        catalog,
        manualOverride: target,
        task: { requiredCapabilities: [capability] },
      });
      expect(decision.candidates[0]?.reasonCodes).toContain("REQUIRED_CAPABILITY_MISSING");
    }
  });
});
