import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dispatcherHandoffTargetOptions } from "./handoff.ts";

const provider = (
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
): ServerProvider => ({
  instanceId: overrides.instanceId,
  driver: overrides.driver,
  displayName: overrides.displayName,
  enabled: overrides.enabled ?? true,
  installed: overrides.installed ?? true,
  version: null,
  status: overrides.status ?? "ready",
  auth: overrides.auth ?? { status: "authenticated" },
  checkedAt: "2026-09-26T00:00:00Z",
  availability: overrides.availability,
  unavailableReason: overrides.unavailableReason,
  models: overrides.models ?? [
    { slug: "model-1", name: "Model 1", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
});

describe("dispatcher handoff target presentation", () => {
  it("excludes the source instance and requires a real available runner", () => {
    const source = ProviderInstanceId.make("codex-work");
    const options = dispatcherHandoffTargetOptions(
      [
        provider({ instanceId: source, driver: ProviderDriverKind.make("codex") }),
        provider({
          instanceId: ProviderInstanceId.make("claude-work"),
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude Work",
        }),
        provider({
          instanceId: ProviderInstanceId.make("cursor-api-model"),
          driver: ProviderDriverKind.make("cursor"),
          installed: false,
          unavailableReason: "/private/provider/path",
        }),
      ],
      source,
    );

    expect(options.map((option) => option.target.instanceId)).not.toContain(source);
    expect(options[0]).toMatchObject({
      providerLabel: "Claude Work",
      available: true,
      unavailableReason: null,
    });
    expect(options[1]).toMatchObject({
      available: false,
      unavailableReason: "Runner not installed",
    });
    expect(JSON.stringify(options)).not.toContain("/private/provider/path");
  });
});
