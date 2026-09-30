import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarInset } from "../ui/sidebar";

/** Viewport-locked inset. Body/#root already clip; this must not grow with content. */
export const WORKSPACE_SCROLL_INSET_CLASS =
  "h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh";

/** Horizontal chat/inspector row. `min-h-0` lets flex children shrink below content. */
export const WORKSPACE_SCROLL_ROW_CLASS = "flex min-h-0 min-w-0 flex-1";

/** Main pane column that hosts the conversation (or Control Center) plus composer. */
export const WORKSPACE_SCROLL_MAIN_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col";

/** Independent vertical scrollport. Height comes from the flex chain, not content. */
export const INDEPENDENT_SCROLL_SURFACE_CLASS = "min-h-0 flex-1 overflow-x-hidden overflow-y-auto";

export const independentScrollSurfaceStyle = {
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
} as const satisfies CSSProperties;

export function WorkspaceScrollPane(props: {
  readonly children: ReactNode;
  readonly inspector: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <SidebarInset className={cn(WORKSPACE_SCROLL_INSET_CLASS, props.className)}>
      <div className={WORKSPACE_SCROLL_ROW_CLASS} data-workspace-scroll-row="">
        <div className={WORKSPACE_SCROLL_MAIN_CLASS} data-workspace-scroll-main="">
          {props.children}
        </div>
        {props.inspector}
      </div>
    </SidebarInset>
  );
}

export function scrollIndependentRegion(element: HTMLElement, delta: number): number {
  const max = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = Math.min(max, Math.max(0, element.scrollTop + delta));
  return element.scrollTop;
}

export function installOverflowMetrics(
  element: HTMLElement,
  input: { readonly clientHeight: number; readonly contentHeight: number },
): void {
  let top = 0;
  const max = Math.max(0, input.contentHeight - input.clientHeight);
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => input.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => input.contentHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(Number(value), max));
    },
  });
}

export function readScrollSurfaceOverflow(element: HTMLElement): string {
  const computed = globalThis.getComputedStyle?.(element).overflowY;
  if (computed === "auto" || computed === "scroll") return computed;
  return element.style.overflowY;
}
