import { useLocation } from "@tanstack/react-router";
import type { ModelRouterMode } from "@t3tools/contracts";

import { ProductRail } from "~/components/controlPlane/ProductRail";
import { ControlCenter } from "~/components/controlPlane/ControlCenter";
import { OperationalInspector } from "~/components/controlPlane/OperationalInspector";
import { WorkspaceScrollPane } from "~/components/controlPlane/workspaceScrollLayout";
import { inspectorModelFromLab, labControlCenterModel } from "./fixtures";
import { LabComposer } from "./LabComposer";
import { LabConversation } from "./LabConversation";
import { LabSidebar } from "./LabSidebar";
import type { LabMessage, LabScenarioState, UiLabScenarioId } from "./scenarios";

export function LabWorkspace(props: {
  readonly scenario: LabScenarioState;
  readonly scenarios: ReadonlyArray<LabScenarioState>;
  readonly mode: ModelRouterMode;
  readonly decision: LabScenarioState["decision"];
  readonly messages: ReadonlyArray<LabMessage>;
  readonly prompt: string;
  readonly error: string | null;
  readonly inspectorCollapsed: boolean;
  readonly onScenarioChange: (id: UiLabScenarioId) => void;
  readonly onModeChange: (mode: ModelRouterMode) => void;
  readonly onPromptChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onDismissError: () => void;
  readonly onToggleInspector: () => void;
}) {
  const location = useLocation();
  const selected =
    props.decision.selected?.target.model ?? props.decision.selected?.target.instanceId ?? "";
  const executed =
    props.decision.executed?.target.model ?? props.decision.selected?.target.model ?? "";
  const search = location.search as { readonly section?: string };
  const showControlCenter = location.pathname === "/control-center";
  const inspectorModel = inspectorModelFromLab({
    decision: props.decision,
    sessionStatus:
      props.scenario.threadStatus === "loading"
        ? "running"
        : props.scenario.threadStatus === "failed" || props.scenario.threadStatus === "error"
          ? "error"
          : props.scenario.threadStatus === "completed"
            ? "ready"
            : "idle",
    error: props.error,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ProductRail pathname={location.pathname} searchSection={search.section ?? null} />
      <LabSidebar
        scenario={props.scenario}
        scenarios={props.scenarios}
        onScenarioChange={props.onScenarioChange}
      />
      <WorkspaceScrollPane
        inspector={
          <OperationalInspector
            collapsed={props.inspectorCollapsed}
            model={inspectorModel}
            onToggle={props.onToggleInspector}
          />
        }
      >
        {showControlCenter ? (
          <ControlCenter model={labControlCenterModel()} />
        ) : (
          <>
            <LabConversation messages={props.messages} scenario={props.scenario} />
            <LabComposer
              decision={props.decision}
              disabled={props.scenario.threadStatus === "loading"}
              error={props.error}
              mode={props.mode}
              prompt={props.prompt}
              onDismissError={props.onDismissError}
              onModeChange={props.onModeChange}
              onPromptChange={props.onPromptChange}
              onSubmit={props.onSubmit}
            />
          </>
        )}
        <span className="sr-only" data-ui-lab-executed-model>
          {executed}
        </span>
        <span className="sr-only" data-ui-lab-selected-model>
          {selected}
        </span>
      </WorkspaceScrollPane>
    </div>
  );
}
