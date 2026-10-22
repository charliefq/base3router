import { useEffect, useRef, useState } from "react";
import { ControllerIdentityView, ControllerStatus } from "@t3tools/contracts";
import {
  controllerActions,
  ControllerClientError,
  type ControllerAction,
  type ControllerKind,
} from "@t3tools/client-runtime/controllers/client";
import {
  connectionLabel,
  onboardingHandoff,
  type ControllerManagement,
} from "@t3tools/client-runtime/controllers/onboarding";
import { Button } from "../../ui/button";

interface Props {
  environmentId: string | null;
  projects: readonly { id: string; title: string }[];
  onProviderSetup: () => void;
  onClose: () => void;
  management?: ControllerManagement;
}
export function ControllerConnect(props: Props) {
  const [controller, setController] = useState<ControllerKind>("grokbot");
  const [binding, setBinding] = useState({ management: props.management, revision: 0 });
  if (binding.management !== props.management)
    setBinding({ management: props.management, revision: binding.revision + 1 });
  return (
    <section
      id="connect-agent"
      aria-label="Connect agent"
      className="mx-auto mb-6 flex max-w-2xl flex-col gap-4 rounded-xl border border-border bg-card p-5"
    >
      <h3 className="font-medium">Connect agent</h3>
      <p className="text-sm text-muted-foreground">
        Execution providers run your coding work. Supervisors such as Grok Bot coordinate governed
        tasks through a separate connection.
      </p>
      <div>
        <Button variant="outline" onClick={props.onProviderSetup}>
          Configure execution provider
        </Button>
      </div>
      <h4 className="text-sm font-medium">Supervisor / controller</h4>
      <div className="flex flex-wrap gap-2" aria-label="Controller choice">
        {(["grokbot", "muse", "dot"] as const).map((kind) => (
          <Button
            key={kind}
            variant={controller === kind ? "default" : "outline"}
            aria-pressed={controller === kind}
            onClick={() => setController(kind)}
          >
            {kind === "grokbot" ? "Grok Bot" : kind === "muse" ? "Muse (future)" : "dot (future)"}
          </Button>
        ))}
      </div>
      <ControllerSetup
        key={`${props.environmentId}:${controller}:${binding.revision}`}
        {...props}
        controller={controller}
      />
      <div>
        <Button variant="ghost" onClick={props.onClose}>
          Close connection setup
        </Button>
      </div>
    </section>
  );
}
function failureMessage(error: unknown) {
  if (error instanceof ControllerClientError) {
    switch (error.code) {
      case "unauthorized":
        return "Owner session unauthorized or expired. Reconnect this environment, then refresh.";
      case "denied":
        return "Owner session denied this operation. Required access permission is missing.";
      case "stale":
      case "conflict":
        return "Bridge state changed. Read current status before reviewing a new operation.";
      case "unavailable":
        return "Controller bridge unavailable in this environment.";
      case "invalid_input":
      case "invalid_request":
        return "Bridge rejected the request. Review the current identity and contract.";
      case "incompatible_response":
        return "Bridge evidence does not match this environment or identity.";
      case "uncertain":
        return "Operation outcome uncertain. The identity binding is retained. Refresh status before retrying the same operation.";
    }
  }
  return "Bridge operation could not be confirmed. The identity binding is retained; refresh status before retrying.";
}
function ControllerSetup({
  controller,
  environmentId,
  projects,
  management,
}: Props & { controller: ControllerKind }) {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [actions, setActions] = useState<ControllerAction[]>(["get_task", "get_result"]);
  const [status, setStatus] = useState<typeof ControllerStatus.Type | null>(null);
  const [identities, setIdentities] = useState<readonly (typeof ControllerIdentityView.Type)[]>([]);
  const [listed, setListed] = useState(false);
  const [controllerId, setControllerId] = useState("");
  const [handoff, setHandoff] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const available = controller === "grokbot" && !!environmentId && !!management;
  const operate = async (action: "list" | "read" | "revoke" | "disconnect") => {
    if (!available || !management || busy.current || (action !== "list" && !controllerId)) return;
    const owner = generation.current;
    const target = controllerId;
    busy.current = true;
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      if (action === "list") {
        const next = await management.list();
        if (generation.current !== owner) return;
        setIdentities(next);
        setListed(true);
      } else if (action === "read") {
        const next = await management.read(target);
        if (next.environmentId !== environmentId || (next.identity && next.identity.id !== target))
          throw new ControllerClientError("incompatible_response");
        if (generation.current === owner) setStatus(next);
      } else {
        // Both actions use the same idempotent server revocation. Forget only after
        // its acknowledgement; a timeout/denial must retain the concrete binding.
        await management.revoke(target);
        if (generation.current !== owner) return;
        if (action === "disconnect") {
          setControllerId("");
          setIdentities([]);
          setListed(false);
        } else
          setStatus({
            version: 1,
            environmentId: environmentId!,
            configuration: "revoked",
            identity: null,
            lastAuthenticatedAt: null,
            tasks: [],
          });
      }
    } catch (cause) {
      if (generation.current === owner) setError(failureMessage(cause));
    } finally {
      if (generation.current === owner) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  const visibleProjectIds = projectIds.filter((id) =>
    projects.some((project) => project.id === id),
  );
  const boundIdentity = status?.identity;
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm font-medium">
        {controller === "grokbot" ? connectionLabel(status) : "Unavailable — future adapter"}
      </p>
      {controller !== "grokbot" ? (
        <p className="text-sm text-muted-foreground">
          This controller has no verified task-control adapter yet.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Select an existing owner-provisioned identity for Grok Bot. This only binds its safe
            metadata in this panel; it grants no access and does not test the external MCP
            connection.
          </p>
          <div>
            <Button
              variant="outline"
              disabled={!available || pending}
              onClick={() => void operate("list")}
            >
              Load controller identities
            </Button>
          </div>
          {listed && identities.length === 0 ? (
            <p>
              No controller identities configured. Owner credential and grant setup is required
              separately.
            </p>
          ) : null}
          <label className="flex flex-col gap-2 text-sm">
            Controller identity
            <select
              aria-label="Controller identity"
              value={controllerId}
              disabled={!available || pending}
              onChange={(event) => {
                generation.current += 1;
                setControllerId(event.target.value);
                setStatus(null);
                setError(null);
              }}
            >
              <option value="">Select an identity explicitly</option>
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.displayName} ({identity.id}){identity.revokedAt ? " — revoked" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Selection is limited to this environment session. Closing setup forgets the selection;
            existing grants remain until Revoke or Disconnect. Never paste a controller token here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!available || pending || !controllerId}
              onClick={() => void operate("read")}
            >
              Check bridge status
            </Button>
            <Button
              variant="outline"
              disabled={
                !available ||
                pending ||
                !controllerId ||
                !status ||
                status.configuration === "revoked"
              }
              onClick={() => void operate("revoke")}
            >
              Revoke controller access
            </Button>
            <Button
              variant="outline"
              disabled={!available || pending || !controllerId || !status}
              onClick={() => void operate("disconnect")}
            >
              Disconnect controller
            </Button>
          </div>
          {!management ? (
            <p className="text-sm text-muted-foreground">
              Connect an authenticated environment owner session to read its controller registry.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm">
              {error}
            </p>
          ) : null}
          <div className="text-sm">
            <h4 className="font-medium">Configured projects / actions</h4>
            <p>
              {boundIdentity
                ? `${boundIdentity.projects.join(", ") || "None"} / ${boundIdentity.actions.join(", ") || "None"}`
                : "No current permission evidence."}
            </p>
            {boundIdentity ? (
              <p>
                Identity: {boundIdentity.id} · Generation: {boundIdentity.generation} · Expires:{" "}
                {boundIdentity.expiresAt}
              </p>
            ) : null}
            <p>
              Last authenticated controller traffic: {status?.lastAuthenticatedAt ?? "Not reported"}
              . This does not prove a live Grok Bot connection.
            </p>
            <h4 className="mt-3 font-medium">Current supervised tasks</h4>
            {status ? (
              <ul>
                {status.tasks
                  .filter(
                    (task) =>
                      task.controllerId === controllerId &&
                      boundIdentity?.projects.includes(task.projectId),
                  )
                  .map((task) => (
                    <li key={task.taskId}>
                      {task.taskId} · {task.run?.status ?? "no run"} · admission {task.admission} ·
                      execution {task.execution} · revision {task.contractRevision} · fence{" "}
                      {task.fence}
                      {task.run ? ` · run ${task.run.runId} / attempt ${task.run.attemptId}` : ""}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>Refresh status to read current supervision evidence.</p>
            )}
            {status && status.tasks.length === 0 ? <p>No supervised tasks reported.</p> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Revocation blocks further controller operations; it does not cancel existing admitted
            work. Disconnect revokes before forgetting this panel's binding.
          </p>
          <details>
            <summary className="text-sm font-medium">Prepare setup handoff (draft only)</summary>
            <div className="mt-3 flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">Requested projects</legend>
                {projects.length === 0 ? (
                  <p>No projects in this environment.</p>
                ) : (
                  projects.map((project) => (
                    <label key={project.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={projectIds.includes(project.id)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setProjectIds((ids) =>
                            checked ? [...ids, project.id] : ids.filter((id) => id !== project.id),
                          );
                          setHandoff(false);
                        }}
                      />
                      {project.title}
                    </label>
                  ))
                )}
              </fieldset>
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-medium">Requested actions</legend>
                {controllerActions.map((action) => (
                  <label key={action} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setActions((values) =>
                          checked
                            ? [...values, action]
                            : values.filter((value) => value !== action),
                        );
                        setHandoff(false);
                      }}
                    />
                    {action}
                  </label>
                ))}
              </fieldset>
              <div>
                <Button
                  variant="outline"
                  disabled={!environmentId || !visibleProjectIds.length || !actions.length}
                  onClick={() => setHandoff(true)}
                >
                  Prepare setup handoff
                </Button>
              </div>
              {handoff ? (
                <pre
                  aria-label="Setup handoff"
                  className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"
                >
                  {JSON.stringify(
                    onboardingHandoff(controller, { projectIds: visibleProjectIds, actions }),
                    null,
                    2,
                  )}
                </pre>
              ) : null}
            </div>
          </details>
          <p className="text-sm text-muted-foreground">
            Feedback is an explicit helpful/not-helpful rating, not a correction prompt. For a new
            prompt through bridge v1, create a new reviewed task and start its first run.
            Existing-task revision and continuation are not supported through this bridge version.
          </p>
          <p className="text-sm text-muted-foreground">
            Grok Bot supports MCP. Its cloud cannot assume localhost or private tailnet
            reachability. Owner-approved endpoint and credential setup remains separate.
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            <a href="https://x.ai/bot/guides/grok-bot-101" target="_blank" rel="noreferrer">
              Official Grok Bot setup
            </a>
            <a href="https://x.ai/changelog/bot" target="_blank" rel="noreferrer">
              MCP reachability notes
            </a>
          </div>
        </>
      )}
    </div>
  );
}
