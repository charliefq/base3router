import { expect, it } from "vite-plus/test";

import { resolveMobileStageLabel, visibleMobileStageLabel } from "./mobileBranding";

it("keeps the variant union and maps Alpha to Internal Alpha for display", () => {
  expect(resolveMobileStageLabel("production")).toBe("Alpha");
  expect(resolveMobileStageLabel("development")).toBe("Dev");
  expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  expect(visibleMobileStageLabel("Alpha")).toBe("Internal Alpha");
  expect(visibleMobileStageLabel("Dev")).toBe("Dev");
  expect(visibleMobileStageLabel("Nightly")).toBe("Nightly");
});
