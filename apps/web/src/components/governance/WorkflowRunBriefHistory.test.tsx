import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type WorkflowCatalog } from "@t3tools/contracts";
import { run, template, profile } from "./WorkflowStagePreview.test-fixtures";
const mocks = vi.hoisted(() => ({
  query: {} as {
    data: WorkflowCatalog;
    isSuccess: boolean;
    isPending: boolean;
    error: null;
    refresh: () => void;
    dataUpdatedAt: number;
  },
  action: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./WorkflowTemplates", () => ({ WorkflowTemplates: () => null }));
vi.mock("./WorkflowStagePreview", () => ({ WorkflowStagePreview: () => null }));
vi.mock("./WorkflowRevisionFeedback", () => ({
  WorkflowRevisionFeedbackForm: () => null,
  WorkflowDecisionHistory: () => null,
}));
vi.mock("../chat/TaskContractPanel", () => ({ TaskContractReadout: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../../hooks/useSettings", () => ({ useUpdateEnvironmentSettings: () => mocks.action }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/governance", () => ({ governanceEnvironment: { snapshot: () => null } }));
vi.mock("../../state/workflow", () => ({
  workflowEnvironment: { catalog: () => "catalog", action: "action", proposeArtifact: "propose" },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mocks.query }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.action }));
import { ProjectWorkflowDecisions } from "./GovernanceSurfaces";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  vi.unstubAllGlobals();
});
it("shows immutable active/paused/terminal run briefs and honest legacy absence across refresh and next run", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.action.mockReset();
  mocks.refresh.mockReset();
  const briefA = "  Run A original 😀\r\nUnchanged requirements.  ";
  const a = { ...run, id: "run-a", brief: briefA };
  const legacy = { ...run, id: "legacy", status: "completed" as const };
  mocks.query = {
    data: { profiles: [profile], templates: [template], runs: [a, legacy] },
    isSuccess: true,
    isPending: false,
    error: null,
    refresh: mocks.refresh,
    dataUpdatedAt: 1,
  };
  const props = {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    projectTitle: "Project",
    refreshTick: 1,
  };
  const render = () => <ProjectWorkflowDecisions {...props} />;
  await act(async () => {
    renderer = create(render());
  });
  const saved = (id: string) =>
    renderer!.root
      .findByProps({ "aria-label": `Run brief ${id}` })
      .findByType("pre")
      .children.join("");
  expect(saved("run-a")).toBe(briefA);
  expect(saved("legacy")).toBe("Run brief not recorded.");
  mocks.query.data = { ...mocks.query.data, runs: [{ ...a, status: "paused" }, legacy] };
  await act(async () => renderer!.update(render()));
  expect(saved("run-a")).toBe(briefA);
  const briefB = "Run B independent context";
  mocks.query.data = {
    ...mocks.query.data,
    runs: [{ ...a, status: "completed" }, { ...run, id: "run-b", brief: briefB }, legacy],
  };
  await act(async () => renderer!.update(render()));
  expect(saved("run-a")).toBe(briefA);
  expect(saved("run-b")).toBe(briefB);
  const refresh = renderer!.root
    .findAllByType("button")
    .find((n) => n.children.join("") === "Refresh workflow evidence")!;
  await act(async () => refresh.props.onClick());
  expect(mocks.refresh).toHaveBeenCalled();
  expect(mocks.action).not.toHaveBeenCalled();
  expect(saved("run-a")).toBe(briefA);
  expect(saved("legacy")).toBe("Run brief not recorded.");
});
