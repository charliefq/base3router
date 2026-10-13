import { useCallback, useEffect, useRef, useState } from "react";
import {
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  type EnvironmentId,
  type EnvironmentRouterPolicyCommand,
  type EnvironmentRouterPolicyStatus,
} from "@t3tools/contracts";
import { routerPolicyControlCommand, routerPolicyStatusCommand } from "../../state/routerPolicy";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

type Action = EnvironmentRouterPolicyCommand["action"];
export function RouterPolicySettings({
  environmentId,
  readOnly,
}: {
  environmentId: EnvironmentId;
  readOnly: boolean;
}) {
  const read = useAtomCommand(routerPolicyStatusCommand, { reportFailure: false });
  const operate = useAtomCommand(routerPolicyControlCommand, { reportFailure: false });
  const [status, setStatus] = useState<EnvironmentRouterPolicyStatus | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const request = ++generation.current;
    const result = await read({ environmentId, input: undefined });
    if (generation.current !== request) return;
    busy.current = false;
    setPending(false);
    if (result._tag === "Success" && result.value.environmentId === environmentId)
      setStatus(result.value);
    else {
      setStatus(null);
      setError("Policy status could not be loaded for this environment. Refresh to try again.");
    }
  }, [environmentId, read]);
  const refresh = () => {
    if (busy.current) return;
    setPending(true);
    setError(null);
    setAction(null);
    setConfirmed(false);
    void load();
  };
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      busy.current = false;
    };
  }, [load]);
  const candidate = status?.policies.find(
    (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION && policy.state !== "active",
  );
  const apply = async () => {
    if (busy.current || !status || !action || !confirmed || readOnly) return;
    const input: EnvironmentRouterPolicyCommand | null =
      action === "rollback"
        ? { action, confirm: true, expectedRevision: status.revision }
        : candidate
          ? {
              action,
              policyId: candidate.policyId,
              confirm: true,
              expectedRevision: status.revision,
            }
          : null;
    if (!input) return;
    busy.current = true;
    const request = ++generation.current;
    setPending(true);
    setError(null);
    const result = await operate({ environmentId, input });
    if (generation.current !== request) return;
    busy.current = false;
    setPending(false);
    setConfirmed(false);
    setAction(null);
    if (
      result._tag === "Success" &&
      result.value.outcome === "applied" &&
      result.value.status.environmentId === environmentId
    )
      setStatus(result.value.status);
    else {
      setStatus(null);
      setError(
        result._tag === "Success" && result.value.outcome === "rejected"
          ? `${result.value.error.detail ?? "Policy transition was rejected."} Refresh before confirming again.`
          : "The operation could not be confirmed. Refresh policy status before confirming again.",
      );
    }
  };
  const choose = (next: Action) => {
    setAction(next);
    setConfirmed(false);
  };
  return (
    <SettingsSection title="Router policy">
      <div className="space-y-3">
        <p>
          Controls future Auto turns in the selected environment. Manual selections and existing
          turns keep their bindings.
        </p>
        <p>
          {status
            ? `Active: ${status.active.policyVersion}. Hybrid: ${candidate?.state ?? (status.active.policyVersion === HYBRID_ROUTER_POLICY_VERSION ? "active" : "unavailable")}.`
            : "Policy status unavailable."}
        </p>
        <p className="text-sm text-muted-foreground">
          Shadow keeps Router V0 and compares Hybrid without changing execution. Active Hybrid uses
          local evidence; missing evidence falls back to Router V0.
        </p>
        {pending && <p role="status">Updating policy status…</p>}
        {error && <p role="alert">{error}</p>}
        {readOnly && <p>Operator permission is required to change policy.</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void refresh()}>
            Refresh policy
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || readOnly || !status || candidate?.state !== "candidate"}
            onClick={() => choose("shadow")}
          >
            Enable shadow
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              pending ||
              readOnly ||
              !status ||
              (candidate?.state !== "shadow" && candidate?.state !== "retired")
            }
            onClick={() => choose("activate")}
          >
            Activate Hybrid
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              pending ||
              readOnly ||
              !status ||
              status.active.policyVersion === MODEL_ROUTER_POLICY_VERSION
            }
            onClick={() => choose("rollback")}
          >
            Restore prior policy
          </Button>
        </div>
        {action && (
          <div className="space-y-2">
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={pending}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I confirm{" "}
              {action === "shadow"
                ? "enabling comparison only; future Auto turns still use Router V0"
                : action === "activate"
                  ? "changing future Auto turns to Hybrid ranking"
                  : "restoring the prior policy for future Auto turns"}{" "}
              in this environment.
            </label>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!confirmed || pending || readOnly}
                onClick={() => void apply()}
              >
                Confirm policy change
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setAction(null);
                  setConfirmed(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
