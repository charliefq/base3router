import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ProductRail } from "./ProductRail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    "aria-label": ariaLabel,
    "aria-current": ariaCurrent,
  }: {
    children: React.ReactNode;
    to?: string;
    "aria-label"?: string;
    "aria-current"?: string;
  }) => (
    <a aria-current={ariaCurrent} aria-label={ariaLabel} href={to}>
      {children}
    </a>
  ),
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render?: React.ReactElement;
    children?: React.ReactNode;
  }) => render ?? children,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

let renderer: ReactTestRenderer | null = null;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON());
}

it("marks Control Center as the current product section", async () => {
  await act(async () => {
    renderer = create(<ProductRail pathname="/control-center" />);
  });

  expect(renderedText()).toContain("Control Center");
  expect(renderedText()).toContain("Projects");
  expect(renderedText()).toContain("Tasks");
  expect(renderedText()).toContain("Workflows");
  expect(renderedText()).toContain("Agents / runs");
  expect(renderedText()).toContain("Settings");
  expect(renderedText()).toContain("aria-current");
});
