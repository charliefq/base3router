import type { InspectorApprovalModel } from "~/controlPlane/presentActionApproval";
import { Button } from "../ui/button";

export type ActionApprovalDecision = "grant" | "deny" | "cancel";

export function ActionApprovalControls(props: {
  readonly approval: InspectorApprovalModel;
  readonly canOperate: boolean;
  readonly submitting: ActionApprovalDecision | null;
  readonly error: string | null;
  readonly disconnected?: boolean;
  readonly onRespond?: (decision: ActionApprovalDecision) => void;
}) {
  const pending = props.approval.status === "pending";
  const busy = props.submitting !== null;
  const disconnected = props.disconnected === true;
  const disabled =
    !pending || busy || !props.canOperate || disconnected || props.onRespond === undefined;
  const state = disconnected
    ? "disconnected"
    : props.error !== null
      ? "error"
      : busy
        ? "submitting"
        : props.approval.status;
  return (
    <div className="mt-1 space-y-1 text-2xs text-muted-foreground" data-action-approval="">
      <p data-action-approval-status={props.approval.status} data-action-approval-state={state}>
        {props.approval.actionType} on {props.approval.destination}
      </p>
      <p>
        Risk {props.approval.riskClass} · side effects {props.approval.sideEffectClass}
      </p>
      <p>Args {props.approval.argumentSummary || "none"}</p>
      <p>
        Scope {props.approval.scope}
        {props.approval.oneTime ? " · One-time" : ` · ${props.approval.reuse}`}
      </p>
      <p>
        Environment {props.approval.environmentId}
        {props.approval.projectId ? ` · project ${props.approval.projectId}` : ""}
        {props.approval.threadId ? ` · thread ${props.approval.threadId}` : ""}
      </p>
      {props.approval.expiresAt ? <p>Expires {props.approval.expiresAt}</p> : null}
      <p>Fingerprint {props.approval.fingerprint}</p>
      <p>ASK because {props.approval.askReason}</p>
      <p>Changed arguments require a new approval.</p>
      {pending ? (
        <div className="flex flex-wrap gap-1 pt-1">
          <Button
            aria-label="Grant once"
            data-action-approval-grant=""
            disabled={disabled}
            size="xs"
            type="button"
            variant="default"
            onClick={() => props.onRespond?.("grant")}
          >
            {props.submitting === "grant" ? "Granting" : "Grant once"}
          </Button>
          <Button
            aria-label="Deny this action"
            data-action-approval-deny=""
            disabled={disabled}
            size="xs"
            type="button"
            variant="destructive-outline"
            onClick={() => props.onRespond?.("deny")}
          >
            {props.submitting === "deny" ? "Denying" : "Deny"}
          </Button>
          <Button
            aria-label="Cancel this pending action"
            data-action-approval-cancel=""
            disabled={disabled}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => props.onRespond?.("cancel")}
          >
            {props.submitting === "cancel" ? "Cancelling" : "Cancel"}
          </Button>
        </div>
      ) : null}
      {props.error !== null ? <p data-action-approval-error="">{props.error}</p> : null}
      {disconnected ? <p>Disconnected. Server state is required before a decision.</p> : null}
    </div>
  );
}
