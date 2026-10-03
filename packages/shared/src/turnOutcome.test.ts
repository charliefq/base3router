import { describe, expect, it } from "vite-plus/test";

import {
  costFromReportedAndEstimate,
  durationMs,
  estimateCatalogCostUsd,
  isImmediateAbandonmentProxy,
  quantityFromOptionalNumber,
  usageFromOpenRouter,
} from "./turnOutcome.ts";

describe("turn outcome measurements", () => {
  it("treats absent numbers as unknown, not zero", () => {
    const missing = quantityFromOptionalNumber({
      value: undefined,
      unit: "usd",
      source: "not_reported",
      provenance: "unknown",
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(missing.status).toBe("unknown");
    expect(missing).not.toHaveProperty("value");
  });

  it("never overwrites reported cost with a catalog estimate", () => {
    const cost = costFromReportedAndEstimate({
      reportedUsd: 0.012,
      estimatedUsd: 0.04,
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(cost.reportedUsd.status).toBe("known");
    if (cost.reportedUsd.status === "known") expect(cost.reportedUsd.value).toBe(0.012);
    expect(cost.estimatedUsd.status).toBe("known");
    expect(cost.mixedProvenance).toBe(true);
    expect(cost.reportedSource).toBe("openrouter_accounting");
  });

  it("rejects non-monotonic durations", () => {
    expect(durationMs(100, 90)).toBeUndefined();
    expect(durationMs(100, 150)).toBe(50);
    expect(isImmediateAbandonmentProxy(30_000)).toBe(true);
    expect(isImmediateAbandonmentProxy(180_000)).toBe(false);
  });

  it("estimates catalog cost from snapshot prices without filling missing tokens as zero", () => {
    expect(
      estimateCatalogCostUsd({
        promptTokens: 100,
        completionTokens: 50,
        promptPricePerToken: 0.000002,
        completionPricePerToken: 0.000008,
      }),
    ).toBeCloseTo(0.0006);
    expect(estimateCatalogCostUsd({ promptTokens: 10 })).toBeUndefined();
  });

  it("preserves OpenRouter usage provenance as estimated when marked", () => {
    const usage = usageFromOpenRouter({
      promptTokens: 15,
      estimated: true,
      observedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(usage.promptTokens.status).toBe("known");
    if (usage.promptTokens.status === "known") {
      expect(usage.promptTokens.provenance).toBe("estimated");
    }
    expect(usage.completionTokens.status).toBe("unknown");
  });
});
