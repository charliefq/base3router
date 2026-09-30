import type { CursorCloudRunnerBinding } from "@t3tools/contracts";
import { PanelRightCloseIcon, PanelRightIcon } from "lucide-react";

import {
  pickDefinedInspectorHandlers,
  resolveCursorCloudInspectorActions,
  type CursorCloudInspectorActionHandlers,
} from "~/controlPlane/inspectorActions";
import type { OperationalInspectorModel } from "~/controlPlane/presentOperationalInspector";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { OperationalStatusCard, statusTone } from "./OperationalStatusCard";

export function OperationalInspector(props: {
  readonly model: OperationalInspectorModel;
  readonly collapsed: boolean;
  readonly followUp?: string;
  readonly busy?: boolean;
  readonly binding?: CursorCloudRunnerBinding | null;
  readonly onToggle: () => void;
  readonly onFollowUpChange?: (value: string) => void;
  readonly onFollowUp?: () => void;
  readonly onCancel?: () => void;
  readonly onRefresh?: () => void;
}) {
  if (props.collapsed) {
    return (
      <aside
        className="flex h-full min-h-0 w-10 shrink-0 flex-col items-center overflow-hidden border-l border-border/80 bg-background pt-3"
        data-control-plane="inspector-collapsed"
      >
        <Button
          aria-label="Open operational inspector"
          size="icon-sm"
          variant="ghost"
          onClick={props.onToggle}
        >
          <PanelRightIcon />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden border-l border-border/80 bg-background"
      data-control-plane="inspector"
    >
      <header className="flex h-(--workspace-topbar-height) items-center justify-between gap-2 px-3">
        <div>
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Inspector
          </p>
          <h2 className="text-sm font-medium">Operation</h2>
        </div>
        <Button
          aria-label="Collapse operational inspector"
          size="icon-sm"
          variant="ghost"
          onClick={props.onToggle}
        >
          <PanelRightCloseIcon />
        </Button>
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-3 pb-4"
        data-workspace-scroll-surface="inspector"
      >
        <InspectorBody {...props} />
      </div>
    </aside>
  );
}

function InspectorBody(props: {
  readonly model: OperationalInspectorModel;
  readonly followUp?: string;
  readonly busy?: boolean;
  readonly binding?: CursorCloudRunnerBinding | null;
  readonly onFollowUpChange?: (value: string) => void;
  readonly onFollowUp?: () => void;
  readonly onCancel?: () => void;
  readonly onRefresh?: () => void;
}) {
  const { model } = props;

  if (model.emptyReason === "no-selection") {
    return (
      <OperationalStatusCard
        title="Selection"
        detail="Select a project or task to inspect route, runner, and workflow state."
      />
    );
  }

  if (model.emptyReason === "capability-off") {
    return (
      <OperationalStatusCard
        title="Capabilities"
        tone="warning"
        value="Off"
        detail="This server does not advertise dispatcher or workflow capabilities. The existing task composer remains available."
      />
    );
  }

  return (
    <>
      <OperationalStatusCard title="Task" detail={model.taskObjective ?? "No task is bound yet."} />
      <OperationalStatusCard
        title="Project"
        detail={model.projectTitle ?? "No project selected."}
      />
      <OperationalStatusCard
        title={model.route.kind === "bound" ? "Bound route" : "Provisional route"}
        tone={statusTone(model.route.gateDecision)}
        value={model.route.kind === "none" ? null : model.route.kind}
        detail={
          model.route.provider && model.route.model
            ? `${model.route.provider} · ${model.route.model}`
            : model.route.reason
        }
      >
        <p className="mt-1 text-2xs text-muted-foreground">{model.route.reason}</p>
        {model.route.mode ? (
          <p className="text-2xs text-muted-foreground">
            Mode: {model.route.mode === "auto" ? "Auto Route" : "Manual"}
          </p>
        ) : null}
        {model.route.policyVersion ? (
          <p className="text-2xs text-muted-foreground">Policy: {model.route.policyVersion}</p>
        ) : null}
        {model.route.source ? (
          <p className="text-2xs text-muted-foreground">Source: {model.route.source}</p>
        ) : null}
        {model.route.reasonCodes.length > 0 ? (
          <p className="text-2xs text-muted-foreground">
            Reasons: {model.route.reasonCodes.join(", ")}
          </p>
        ) : null}
        {model.route.fallbacks.length > 0 ? (
          <p className="text-2xs text-muted-foreground">
            Fallbacks:{" "}
            {model.route.fallbacks.map((entry) => `${entry.provider} · ${entry.model}`).join(", ")}
          </p>
        ) : null}
        <p className="text-2xs text-muted-foreground">
          Cost:{" "}
          {model.route.estimatedCostUsd?.status === "known"
            ? model.route.estimatedCostUsd.value
            : "unknown"}
          {" · "}
          Latency:{" "}
          {model.route.estimatedLatencyMs?.status === "known"
            ? model.route.estimatedLatencyMs.value
            : "unknown"}
          {" · "}
          Quality:{" "}
          {model.route.estimatedQuality?.status === "known"
            ? model.route.estimatedQuality.value
            : "unknown"}
        </p>
        {model.route.executionStatus ? (
          <p className="text-2xs text-muted-foreground">Execution: {model.route.executionStatus}</p>
        ) : null}
      </OperationalStatusCard>
      <OperationalStatusCard
        title="ActionGate"
        tone={statusTone(model.route.gateDecision)}
        value={model.route.gateDecision}
        detail={
          model.route.gateReasons.length > 0
            ? model.route.gateReasons.join(", ")
            : "No ActionGate reasons."
        }
      />
      <OperationalStatusCard
        title="Runner"
        value={model.runnerKind}
        detail={
          model.runnerKind === "cursor-cloud"
            ? "Cursor Cloud is the selected runner, not a provider."
            : model.runnerKind === "local"
              ? "Local provider runner."
              : "Runner is not bound yet."
        }
      />
      <OperationalStatusCard
        title="Agent / run"
        value={model.sessionStatus ?? "idle"}
        tone={statusTone(model.sessionStatus)}
        detail={model.error}
      >
        {model.cursorCloud?.agentId ? (
          <p className="mt-1 text-2xs text-muted-foreground">Agent {model.cursorCloud.agentId}</p>
        ) : null}
        {model.cursorCloud?.runId ? (
          <p className="text-2xs text-muted-foreground">Run {model.cursorCloud.runId}</p>
        ) : null}
      </OperationalStatusCard>
      {model.stages.length > 0 ? (
        <OperationalStatusCard
          title="Workflow"
          value={model.workflowStatus ?? null}
          tone={statusTone(model.workflowStatus)}
          detail={model.workflowName}
        >
          <ol className="mt-2 space-y-1">
            {model.stages.map((stage) => (
              <li
                className="flex items-center justify-between gap-2 text-2xs"
                data-current={stage.current ? "true" : "false"}
                key={stage.id}
              >
                <span className={stage.current ? "text-foreground" : "text-muted-foreground"}>
                  {stage.label}
                </span>
                <span className="text-muted-foreground">{stage.status}</span>
              </li>
            ))}
          </ol>
        </OperationalStatusCard>
      ) : model.capabilities.workflow ? (
        <OperationalStatusCard title="Workflow" detail="No workflow is attached to this task." />
      ) : null}
      {model.cursorCloud ? (
        <OperationalStatusCard
          title="Cursor Cloud"
          value={model.cursorCloud.status}
          tone={statusTone(model.cursorCloud.status)}
        >
          {model.cursorCloud.repository ? (
            <p className="mt-1 break-all text-2xs text-muted-foreground">
              {model.cursorCloud.repository}
            </p>
          ) : null}
          {model.cursorCloud.branch ? (
            <p className="text-2xs text-muted-foreground">Branch {model.cursorCloud.branch}</p>
          ) : null}
          {model.cursorCloud.commit ? (
            <p className="break-all text-2xs text-muted-foreground">
              Commit {model.cursorCloud.commit}
            </p>
          ) : null}
          {model.cursorCloud.pullRequestUrl ? (
            <p className="break-all text-2xs text-muted-foreground">
              {model.cursorCloud.pullRequestUrl}
            </p>
          ) : null}
          {model.cursorCloud.result ? (
            <p className="mt-1 text-sm">{model.cursorCloud.result}</p>
          ) : null}
          {model.cursorCloud.error ? (
            <p className="mt-1 text-sm text-error-foreground">{model.cursorCloud.error}</p>
          ) : null}
          {props.binding ? (
            <CursorCloudInspectorControls
              binding={props.binding}
              busy={props.busy === true}
              followUp={props.followUp ?? ""}
              {...pickDefinedInspectorHandlers(props)}
            />
          ) : (
            <p className="mt-2 text-2xs text-muted-foreground">
              Create a Cursor Cloud run from the workspace workflow controls. Credentials stay on
              the server.
            </p>
          )}
        </OperationalStatusCard>
      ) : null}
      <OperationalStatusCard title="Git" detail={model.gitBranch ?? "No branch is recorded."} />
    </>
  );
}

function CursorCloudInspectorControls(
  props: {
    readonly binding: CursorCloudRunnerBinding;
    readonly followUp: string;
    readonly busy: boolean;
  } & CursorCloudInspectorActionHandlers,
) {
  const actions = resolveCursorCloudInspectorActions({
    binding: props.binding,
    busy: props.busy,
    followUp: props.followUp,
    handlers: props,
  });

  if (actions.readOnly) {
    return (
      <p className="mt-2 text-2xs text-muted-foreground" data-control-plane="inspector-readonly">
        Read only
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {actions.followUpEditable ? (
        <Textarea
          aria-label="Cursor Cloud follow-up"
          maxLength={16_000}
          value={props.followUp}
          onChange={(event) => props.onFollowUpChange?.(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {actions.followUp.available ? (
          <Button
            data-control-plane="inspector-follow-up"
            disabled={!actions.followUp.enabled}
            size="xs"
            onClick={props.onFollowUp}
          >
            Follow up
          </Button>
        ) : null}
        {actions.cancel.available ? (
          <Button
            data-control-plane="inspector-cancel"
            disabled={!actions.cancel.enabled}
            size="xs"
            variant="outline"
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        ) : null}
        {actions.refresh.available ? (
          <Button
            data-control-plane="inspector-refresh"
            disabled={!actions.refresh.enabled}
            size="xs"
            variant="ghost"
            onClick={props.onRefresh}
          >
            Refresh
          </Button>
        ) : null}
      </div>
    </div>
  );
}
