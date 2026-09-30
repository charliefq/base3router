export const PRODUCT_SECTIONS = [
  "control-center",
  "projects",
  "tasks",
  "workflows",
  "agents",
  "settings",
] as const;

export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

export type ProductSectionTarget = {
  readonly section: ProductSection;
  readonly to: "/control-center" | "/" | "/settings";
  readonly search?: { readonly section: "workflows" | "agents" };
};

export function resolveProductSection(input: {
  readonly pathname: string;
  readonly searchSection?: string | null;
}): ProductSection {
  if (input.pathname === "/settings" || input.pathname.startsWith("/settings/")) {
    return "settings";
  }
  if (input.pathname === "/control-center") {
    if (input.searchSection === "workflows") return "workflows";
    if (input.searchSection === "agents") return "agents";
    return "control-center";
  }
  return "tasks";
}

export function productSectionTarget(section: ProductSection): ProductSectionTarget {
  switch (section) {
    case "settings":
      return { section, to: "/settings" };
    case "workflows":
      return { section, to: "/control-center", search: { section: "workflows" } };
    case "agents":
      return { section, to: "/control-center", search: { section: "agents" } };
    case "control-center":
      return { section, to: "/control-center" };
    case "projects":
    case "tasks":
      return { section, to: "/" };
  }
}

export function productSectionLabel(section: ProductSection): string {
  switch (section) {
    case "control-center":
      return "Control Center";
    case "projects":
      return "Projects";
    case "tasks":
      return "Tasks";
    case "workflows":
      return "Workflows";
    case "agents":
      return "Agents / runs";
    case "settings":
      return "Settings";
  }
}

const INSPECTOR_COLLAPSE_WIDTH = 1280;

export function shouldCollapseInspector(viewportWidth: number): boolean {
  return viewportWidth < INSPECTOR_COLLAPSE_WIDTH;
}

export const INSPECTOR_OPEN_STORAGE_KEY = "base3router:inspector-open";
