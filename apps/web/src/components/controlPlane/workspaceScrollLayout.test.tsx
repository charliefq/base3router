import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import type { ControlCenterModel } from "~/controlPlane/presentControlCenter";
import { ControlCenter } from "./ControlCenter";
import {
  INDEPENDENT_SCROLL_SURFACE_CLASS,
  WORKSPACE_SCROLL_INSET_CLASS,
  WORKSPACE_SCROLL_MAIN_CLASS,
  WORKSPACE_SCROLL_ROW_CLASS,
  WorkspaceScrollPane,
  independentScrollSurfaceStyle,
  installOverflowMetrics,
  readScrollSurfaceOverflow,
  scrollIndependentRegion,
} from "./workspaceScrollLayout";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}));

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

const overflowingModel: ControlCenterModel = {
  selectedEnvironmentId: environmentId,
  surface: "ready",
  capabilities: { dispatcher: true, workflow: true, cursorCloud: false },
  projects: Array.from({ length: 12 }, (_, index) => ({
    id: ProjectId.make(`project-${index}`),
    environmentId,
    title: `Project ${index}`,
    taskCount: 4,
  })),
  recentTasks: Array.from({ length: 20 }, (_, index) => ({
    id: ThreadId.make(`thread-${index}`),
    environmentId,
    projectId,
    title: `Task ${index}`,
    projectTitle: "Portfolio",
    status: "active" as const,
    routeLabel: "codex · gpt-5.4",
    runnerKind: "local" as const,
  })),
  activeRuns: [],
  approvals: [],
  failedOrCancelled: [],
  empty: false,
  capabilityOff: false,
};

let renderer: ReactTestRenderer | null = null;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function renderedTree(): string {
  return JSON.stringify(renderer?.toJSON());
}

function OverflowRegion(props: {
  readonly name: "thread-list" | "conversation" | "inspector";
  readonly count: number;
}) {
  return (
    <div
      className={INDEPENDENT_SCROLL_SURFACE_CLASS}
      data-workspace-scroll-surface={props.name}
      style={{ ...independentScrollSurfaceStyle, height: "100%" }}
    >
      {Array.from({ length: props.count }, (_, index) => (
        <div key={index} style={{ height: 48 }}>
          {props.name} {index}
        </div>
      ))}
    </div>
  );
}

function ReducedDesktopShell(props: { readonly height: number }) {
  return (
    <div data-desktop-window="" style={{ height: props.height, overflow: "hidden", width: 1100 }}>
      <aside data-slot="sidebar-inner">
        <div>Threads</div>
        <OverflowRegion count={40} name="thread-list" />
        <div>Footer</div>
      </aside>
      <WorkspaceScrollPane
        inspector={
          <aside data-control-plane="inspector">
            <div>Inspector</div>
            <OverflowRegion count={30} name="inspector" />
          </aside>
        }
      >
        <div style={{ minHeight: 0, position: "relative" }}>
          <OverflowRegion count={50} name="conversation" />
          <div data-chat-composer-overlay="true" style={{ position: "absolute", bottom: 0 }}>
            <div data-chat-composer-stack="true">composer</div>
          </div>
        </div>
      </WorkspaceScrollPane>
    </div>
  );
}

function overflowingSurface(name: string, clientHeight: number, rows: number): HTMLElement {
  const element = {
    style: { ...independentScrollSurfaceStyle },
    dataset: { workspaceScrollSurface: name },
  } as unknown as HTMLElement;
  installOverflowMetrics(element, { clientHeight, contentHeight: rows * 48 });
  return element;
}

describe("independent workspace scroll regions", () => {
  it("scrolls overflowing thread, conversation, and inspector regions independently", () => {
    const threadList = overflowingSurface("thread-list", 280, 40);
    const conversation = overflowingSurface("conversation", 200, 50);
    const inspector = overflowingSurface("inspector", 220, 30);

    expect(readScrollSurfaceOverflow(threadList)).toMatch(/auto|scroll/);
    expect(readScrollSurfaceOverflow(conversation)).toMatch(/auto|scroll/);
    expect(readScrollSurfaceOverflow(inspector)).toMatch(/auto|scroll/);
    expect(threadList.scrollHeight).toBeGreaterThan(threadList.clientHeight);
    expect(conversation.scrollHeight).toBeGreaterThan(conversation.clientHeight);

    expect(scrollIndependentRegion(threadList, 160)).toBe(160);
    expect(conversation.scrollTop).toBe(0);
    expect(inspector.scrollTop).toBe(0);

    expect(scrollIndependentRegion(conversation, 220)).toBe(220);
    expect(threadList.scrollTop).toBe(160);
    expect(inspector.scrollTop).toBe(0);

    expect(scrollIndependentRegion(inspector, 90)).toBe(90);
    expect(scrollIndependentRegion(conversation, 10_000)).toBe(
      conversation.scrollHeight - conversation.clientHeight,
    );
  });

  it("still scrolls the conversation after the window is shortened and keeps the composer mounted", async () => {
    await act(async () => {
      renderer = create(<ReducedDesktopShell height={360} />);
    });
    expect(renderedTree()).toContain("data-desktop-window");
    expect(renderedTree()).toContain("data-workspace-scroll-row");
    expect(renderedTree()).toContain("data-workspace-scroll-main");
    expect(renderedTree()).toContain('"thread-list"," ","39"');
    expect(renderedTree()).toContain('"conversation"," ","49"');
    expect(renderedTree()).toContain("composer");

    await act(async () => {
      renderer?.update(<ReducedDesktopShell height={240} />);
    });

    const conversation = overflowingSurface("conversation", 184, 50);
    expect(conversation.scrollHeight - conversation.clientHeight).toBeGreaterThan(240);
    expect(scrollIndependentRegion(conversation, 400)).toBe(400);
    expect(renderedTree()).toContain("composer");
    expect(renderedTree()).toContain("data-chat-composer-overlay");
  });

  it("lets an overflowing Control Center body change scrollTop", async () => {
    await act(async () => {
      renderer = create(
        <div style={{ height: 280, overflow: "hidden" }}>
          <ControlCenter model={overflowingModel} />
        </div>,
      );
    });

    expect(renderedTree()).toContain("data-workspace-scroll-surface");
    expect(renderedTree()).toContain("control-center");
    expect(renderedTree()).toContain("Task 19");
    expect(renderedTree()).toContain("Project 11");

    const controlCenter = overflowingSurface("control-center", 220, 40);
    expect(readScrollSurfaceOverflow(controlCenter)).toMatch(/auto|scroll/);
    expect(scrollIndependentRegion(controlCenter, 180)).toBe(180);
  });

  it("exports a shrinkable flex chain and overflow-y auto on scroll surfaces", () => {
    expect(WORKSPACE_SCROLL_INSET_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-h-0", "overflow-hidden"]),
    );
    expect(WORKSPACE_SCROLL_ROW_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1"]),
    );
    expect(WORKSPACE_SCROLL_MAIN_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-h-0", "flex-col"]),
    );
    expect(INDEPENDENT_SCROLL_SURFACE_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining(["min-h-0", "overflow-y-auto"]),
    );
  });
});
