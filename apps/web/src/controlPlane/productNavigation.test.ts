import { expect, it } from "vite-plus/test";

import {
  PRODUCT_SECTIONS,
  productSectionLabel,
  productSectionTarget,
  resolveProductSection,
  shouldCollapseInspector,
} from "./productNavigation";

it("exposes the product sections the rail can select", () => {
  expect(PRODUCT_SECTIONS).toContain("control-center");
  expect(PRODUCT_SECTIONS).toContain("settings");
});

it("resolves Control Center, settings, and task sections from the path", () => {
  expect(resolveProductSection({ pathname: "/control-center" })).toBe("control-center");
  expect(resolveProductSection({ pathname: "/control-center", searchSection: "workflows" })).toBe(
    "workflows",
  );
  expect(resolveProductSection({ pathname: "/control-center", searchSection: "agents" })).toBe(
    "agents",
  );
  expect(resolveProductSection({ pathname: "/settings/general" })).toBe("settings");
  expect(resolveProductSection({ pathname: "/" })).toBe("tasks");
});

it("keeps create/select targets on existing routes", () => {
  expect(productSectionTarget("projects")).toEqual({ section: "projects", to: "/" });
  expect(productSectionTarget("tasks")).toEqual({ section: "tasks", to: "/" });
  expect(productSectionTarget("settings")).toEqual({ section: "settings", to: "/settings" });
  expect(productSectionTarget("workflows")).toEqual({
    section: "workflows",
    to: "/control-center",
    search: { section: "workflows" },
  });
  expect(productSectionLabel("control-center")).toBe("Control Center");
});

it("collapses the inspector on narrow desktop widths", () => {
  expect(shouldCollapseInspector(1279)).toBe(true);
  expect(shouldCollapseInspector(1280)).toBe(false);
});
