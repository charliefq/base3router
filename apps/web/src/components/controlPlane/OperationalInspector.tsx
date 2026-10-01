import type { CursorCloudRunnerBinding } from "@t3tools/contracts";
import { PanelRightCloseIcon, PanelRightIcon } from "lucide-react";

import {
  pickDefinedInspectorHandlers,
  resolveCursorCloudInspectorActions,
  type CursorCloudInspectorActionHandlers,
} from "~/controlPlane/inspectorActions";
import type {
  InspectorOpenRouterModel,
  InspectorRouteModel,
  OperationalInspectorModel,
} from "~/controlPlane/presentOperationalInspector";
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
      className="flex h-full min-h-0 w-(--control-plane-inspector-width) shrink-0 flex-col overflow-hidden border-l border-border/80 bg-background"
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
        detail="No project or task is selected. Auto Route and Manual traces appear here after a thread is open."
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
      <RouteTraceCard route={model.route} />
      {model.openRouter ? <OpenRouterGuidanceCard model={model.openRouter} /> : null}
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

function routeModeLabel(mode: InspectorRouteModel["mode"]): string {
  if (mode === "auto") return "Auto Route";
  if (mode === "manual") return "Manual";
  return "Unrouted";
}

function metricLabel(label: string, value: InspectorRouteModel["estimatedCostUsd"]): string {
  if (value?.status === "known") return `${label} ${value.value}`;
  return `${label} unknown`;
}

function RouteTraceCard(props: { readonly route: InspectorRouteModel }) {
  const { route } = props;
  const modeLabel = routeModeLabel(route.mode);
  const title =
    route.kind === "bound"
      ? "Bound route"
      : route.kind === "provisional"
        ? "Provisional route"
        : route.kind === "unavailable"
          ? "Unavailable route"
          : "Route";
  const target =
    route.provider && route.model ? `${route.provider} · ${route.model}` : route.reason;
  const hasDetails =
    route.policyVersion !== null ||
    route.source !== null ||
    route.reasonCodes.length > 0 ||
    route.fallbacks.length > 0 ||
    route.attempts.length > 0 ||
    route.eligibleCount !== null ||
    route.attemptBudget !== null;

  return (
    <OperationalStatusCard
      detail={target}
      title={title}
      tone={statusTone(route.executionStatus ?? route.kind)}
      value={modeLabel}
    >
      <p
        className="mt-1 text-2xs text-muted-foreground"
        data-inspector-route-mode={route.mode ?? ""}
      >
        {route.mode === "auto"
          ? "Base3Router selected an eligible model. This is not Access Auto and not a provider slug named auto."
          : route.mode === "manual"
            ? "The user chose this model. Auto Route is off for this turn."
            : "No Auto Route or Manual decision is bound yet."}
      </p>
      <p className="text-2xs text-muted-foreground">{route.reason}</p>
      {route.executionStatus ? (
        <p className="text-2xs text-muted-foreground" data-inspector-route-execution="">
          Execution: {route.executionStatus}
        </p>
      ) : null}
      {route.rerouted && route.initialModel && route.executedModel ? (
        <p className="text-2xs text-muted-foreground">
          Rerouted from {route.initialProvider} · {route.initialModel} to {route.executedProvider} ·{" "}
          {route.executedModel}
        </p>
      ) : null}
      {hasDetails ? (
        <details
          className="mt-2"
          data-inspector-route-details=""
          open={
            route.attempts.length > 0 ||
            route.rerouted ||
            route.executionStatus === "failed" ||
            route.kind === "unavailable"
          }
        >
          <summary className="cursor-pointer text-2xs font-medium text-foreground">
            Route details
          </summary>
          <div className="mt-1 space-y-1 text-2xs text-muted-foreground">
            {route.policyVersion ? <p>Policy: {route.policyVersion}</p> : null}
            {route.source ? <p>Decision source: {route.source}</p> : null}
            {route.eligibleCount !== null ? (
              <p>
                Eligibility: {route.eligibleCount} eligible
                {route.filteredCount !== null && route.filteredCount > 0
                  ? ` · ${route.filteredCount} filtered`
                  : ""}
              </p>
            ) : null}
            {route.filteredReasonCodes.length > 0 ? (
              <p>Constraints: {route.filteredReasonCodes.join(", ")}</p>
            ) : null}
            {route.reasonCodes.length > 0 ? (
              <p>Tie-break / reasons: {route.reasonCodes.join(", ")}</p>
            ) : null}
            {route.fallbacks.length > 0 ? (
              <p>
                Fallback order:{" "}
                {route.fallbacks.map((entry) => `${entry.provider} · ${entry.model}`).join(", ")}
              </p>
            ) : null}
            {route.attemptBudget !== null ? <p>Attempt budget: {route.attemptBudget}</p> : null}
            <p>
              Metrics: {metricLabel("cost", route.estimatedCostUsd)} ·{" "}
              {metricLabel("latency", route.estimatedLatencyMs)} ·{" "}
              {metricLabel("quality", route.estimatedQuality)}
            </p>
            {route.attempts.length > 0 ? (
              <ol className="list-decimal pl-4" data-model-router-attempts="">
                {route.attempts.map((attempt) => (
                  <li
                    data-model-router-attempt={String(attempt.attempt)}
                    data-model-router-attempt-model={attempt.target.model}
                    data-model-router-attempt-outcome={attempt.outcome}
                    key={`${attempt.attempt}-${attempt.target.instanceId}-${attempt.target.model}`}
                  >
                    Attempt {attempt.attempt}: {attempt.target.instanceId} · {attempt.target.model}{" "}
                    · {attempt.outcome}
                    {attempt.failureCategory ? ` · ${attempt.failureCategory}` : ""}
                    {attempt.failureScope ? ` · ${attempt.failureScope}` : ""}
                    {attempt.fallbackAllowed ? " · fallback allowed" : " · fallback blocked"}
                    {attempt.nextTarget
                      ? ` · next ${attempt.nextTarget.instanceId} · ${attempt.nextTarget.model}`
                      : ""}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </details>
      ) : (
        <p className="mt-1 text-2xs text-muted-foreground">
          Metrics: {metricLabel("cost", route.estimatedCostUsd)} ·{" "}
          {metricLabel("latency", route.estimatedLatencyMs)} ·{" "}
          {metricLabel("quality", route.estimatedQuality)}
        </p>
      )}
    </OperationalStatusCard>
  );
}

function OpenRouterGuidanceCard(props: { readonly model: InspectorOpenRouterModel }) {
  const { model } = props;
  const requested = model.requestedRouterTarget;
  const actual = model.actualModel;
  const differs = requested !== null && actual !== null && requested !== actual;
  return (
    <OperationalStatusCard
      title="OpenRouter guidance"
      value={model.mode}
      detail={`Status ${model.status}. Privacy ${model.privacyPolicy}.`}
      tone={
        model.status === "failed" || model.status === "policy_violation"
          ? "danger"
          : model.status === "skipped"
            ? "warning"
            : "neutral"
      }
    >
      <div className="mt-1 space-y-1 text-2xs text-muted-foreground" data-openrouter-inspector="">
        <p data-openrouter-mode={model.mode}>Mode: {model.mode}</p>
        <p data-openrouter-task-source={model.taskSource}>
          Task: {model.taskTag ?? "unknown"} ({model.taskSource})
        </p>
        {model.base3Model ? <p data-openrouter-base3="">Base3Router: {model.base3Model}</p> : null}
        {model.openRouterModel ? (
          <p data-openrouter-suggested="">OpenRouter: {model.openRouterModel}</p>
        ) : null}
        {differs ? (
          <p data-openrouter-actual="">
            Requested {requested} · actual {actual}
          </p>
        ) : null}
        <p data-openrouter-agreement={model.agreement}>Agreement: {model.agreement}</p>
        {model.skipReason ? <p data-openrouter-skip="">Skipped: {model.skipReason}</p> : null}
        {model.errorCategory ? (
          <p data-openrouter-error="">Failure: {model.errorCategory}</p>
        ) : null}
        {model.nestedFallbacks.length > 0 ? (
          <ol data-openrouter-nested-fallbacks="">
            {model.nestedFallbacks.map((entry, index) => (
              <li key={`${index}-${entry}`}>{entry}</li>
            ))}
          </ol>
        ) : null}
        {model.freshness ? (
          <p data-openrouter-freshness={model.freshness}>Priors {model.freshness}</p>
        ) : null}
        {model.asOf ? <p data-openrouter-as-of="">Observed {model.asOf}</p> : null}
      </div>
    </OperationalStatusCard>
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
