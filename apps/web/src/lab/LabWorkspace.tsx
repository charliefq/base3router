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
import type { ActionApprovalDecision } from "~/components/controlPlane/ActionApprovalControls";
import type { InspectorApprovalModel } from "~/controlPlane/presentOperationalInspector";
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
  readonly liveApproval?: InspectorApprovalModel | null;
  readonly approvalSubmitting?: ActionApprovalDecision | null;
  readonly approvalError?: string | null;
  readonly onApprovalRespond?: (decision: ActionApprovalDecision) => void;
  readonly toolExecutions?: number;
}) {
  const location = useLocation();
  const selected =
    props.decision.selected?.target.model ?? props.decision.selected?.target.instanceId ?? "";
  const executed =
    props.decision.executed?.target.model ?? props.decision.selected?.target.model ?? "";
  const search = location.search as { readonly section?: string };
  const showControlCenter =
    location.pathname === "/control-center" || props.scenario.view === "control-center";
  const governance = props.scenario.actionGovernance;
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
    overflow:
      props.scenario.id === "long-thread" ||
      props.scenario.id === "narrow-width" ||
      props.scenario.id === "reduced-height",
    empty: props.scenario.inspectorEmpty,
    ...(props.scenario.longNames
      ? {
          projectTitle: "Very-long-environment-project-name-that-must-truncate-without-overflow",
          taskObjective: "A-unusually-long-thread-title-for-Inspector-truncation-checks",
        }
      : {}),
    ...(props.scenario.openRouter !== undefined ? { openRouter: props.scenario.openRouter } : {}),
    ...(props.scenario.hybrid !== undefined ? { hybrid: props.scenario.hybrid } : {}),
    ...(props.scenario.skillRoute !== undefined ? { skillRoute: props.scenario.skillRoute } : {}),
    ...(props.scenario.mcpRoute !== undefined ? { mcpRoute: props.scenario.mcpRoute } : {}),
    ...(props.scenario.executionPlan !== undefined
      ? { executionPlan: props.scenario.executionPlan }
      : {}),
    ...(props.scenario.actionGate !== undefined ? { actionGate: props.scenario.actionGate } : {}),
    ...(props.liveApproval !== undefined
      ? { approval: props.liveApproval }
      : props.scenario.approval !== undefined
        ? { approval: props.scenario.approval }
        : {}),
    ...(props.scenario.toolExecution !== undefined
      ? { toolExecution: props.scenario.toolExecution }
      : {}),
    ...(props.scenario.outcome !== undefined ? { outcome: props.scenario.outcome } : {}),
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
            canOperate={true}
            approvalSubmitting={props.approvalSubmitting ?? null}
            approvalError={props.approvalError ?? null}
            onToggle={props.onToggleInspector}
            {...(props.onApprovalRespond !== undefined
              ? { onApprovalRespond: props.onApprovalRespond }
              : {})}
          />
        }
      >
        {showControlCenter ? (
          <ControlCenter
            model={labControlCenterModel({
              surface:
                props.scenario.id === "disconnected"
                  ? "offline"
                  : props.scenario.id === "empty-workspace" ||
                      props.scenario.id === "eval-no-observations"
                    ? "unpaired"
                    : "ready",
              empty:
                props.scenario.id === "empty-workspace" ||
                props.scenario.id === "eval-no-observations",
              longNames: props.scenario.longNames,
              ...(props.scenario.id === "disconnected"
                ? { environmentLabel: "Offline lab environment" }
                : {}),
              ...(props.scenario.routerInsights !== undefined
                ? { routerInsights: props.scenario.routerInsights }
                : {}),
              ...(governance !== undefined && governance !== null
                ? {
                    actionGovernance: {
                      configuredSkills: governance.configuredSkills,
                      configuredMcp: governance.configuredMcp,
                      pendingApprovals: governance.pendingApprovals,
                      deniedExpired: governance.deniedExpired,
                      recentOutcomes: governance.recentOutcomes,
                      costExposure: governance.costExposure,
                      compliance: governance.compliance,
                      pendingCards:
                        props.liveApproval != null ? [props.liveApproval] : governance.pendingCards,
                    },
                  }
                : {}),
            })}
            {...(props.onApprovalRespond !== undefined
              ? {
                  approvalActions: {
                    canOperate: true,
                    submittingDecision: props.approvalSubmitting ?? null,
                    error: props.approvalError ?? null,
                    onRespond: (_approvalId, decision) => props.onApprovalRespond?.(decision),
                  },
                }
              : {})}
          />
        ) : (
          <>
            <LabConversation messages={props.messages} scenario={props.scenario} />
            <LabComposer
              decision={props.decision}
              disabled={props.scenario.threadStatus === "loading"}
              error={props.error}
              mode={props.mode}
              prompt={props.prompt}
              {...(props.scenario.openRouterControl !== undefined
                ? { openRouter: props.scenario.openRouterControl }
                : {})}
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
        <span className="sr-only" data-ui-lab-tool-executions>
          {String(props.toolExecutions ?? 0)}
        </span>
      </WorkspaceScrollPane>
    </div>
  );
}
