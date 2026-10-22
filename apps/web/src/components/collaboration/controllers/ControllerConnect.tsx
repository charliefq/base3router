import { useEffect, useRef, useState } from "react";
import {
  controllerActions,
  type ControllerAction,
  type ControllerKind,
} from "@t3tools/client-runtime/controllers/client";
import {
  connectionLabel,
  onboardingHandoff,
  type ControllerConnection,
  type ControllerManagement,
} from "@t3tools/client-runtime/controllers/onboarding";
import { Button } from "../../ui/button";

interface Props {
  environmentId: string | null;
  projects: readonly { id: string; title: string }[];
  onProviderSetup: () => void;
  onClose: () => void;
  /** Final integration injects the authenticated administrative bridge binding. */
  management?: ControllerManagement;
}
export function ControllerConnect(props: Props) {
  const [controller, setController] = useState<ControllerKind>("grokbot");
  const [binding, setBinding] = useState({ management: props.management, revision: 0 });
  if (binding.management !== props.management) {
    setBinding({ management: props.management, revision: binding.revision + 1 });
  }
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
function ControllerSetup({
  controller,
  environmentId,
  projects,
  management,
}: Props & { controller: ControllerKind }) {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [actions, setActions] = useState<ControllerAction[]>(["get_task", "get_result"]);
  const [connection, setConnection] = useState<ControllerConnection | null>(null);
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
  const operate = async (action: "read" | "revoke" | "disconnect") => {
    if (!available || !management || busy.current) return;
    const owner = generation.current;
    busy.current = true;
    setPending(true);
    setError(null);
    // An old verification must not survive a failed refresh or uncertain revocation.
    setConnection(null);
    try {
      let next: ControllerConnection;
      if (action === "read") {
        next = await management.read(controller);
        if (
          next.version !== 1 ||
          next.controller !== controller ||
          next.environmentId !== environmentId ||
          !next.callerId
        ) {
          throw new Error("Incompatible bridge evidence");
        }
      } else {
        await management[action](controller);
        next = {
          version: 1,
          controller,
          environmentId: environmentId!,
          callerId: "disconnected",
          status: action === "revoke" ? "revoked" : "disconnected",
          evidence: "bridge",
          verifiedAt: null,
          grant: { projectIds: [], actions: [] },
          tasks: [],
        };
      }
      if (generation.current === owner) setConnection(next);
    } catch {
      if (generation.current === owner)
        setError(
          "Bridge operation could not be confirmed. Refresh status before taking further action.",
        );
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
  const activeConnection = connection?.status === "verified_connected" && !!connection.verifiedAt;
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-sm font-medium">
        {controller === "grokbot" ? connectionLabel(connection) : "Unavailable — future adapter"}
      </p>
      {controller !== "grokbot" ? (
        <p className="text-sm text-muted-foreground">
          This controller has no verified task-control adapter yet.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Grok Bot supports MCP. The controller bridge and a reachable authenticated endpoint must
            be configured before connecting. Private tailnet and localhost addresses cannot be
            assumed reachable from its cloud.
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Requested projects (draft only)</legend>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment with projects first.
              </p>
            ) : (
              projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(project.id)}
                    onChange={(event) => {
                      setProjectIds((ids) =>
                        event.target.checked
                          ? [...ids, project.id]
                          : ids.filter((id) => id !== project.id),
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
            <legend className="mb-2 text-sm font-medium">Requested actions (draft only)</legend>
            {controllerActions.map((action) => (
              <label key={action} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={actions.includes(action)}
                  onChange={(event) => {
                    setActions((values) =>
                      event.target.checked
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!environmentId || visibleProjectIds.length === 0 || actions.length === 0}
              onClick={() => setHandoff(true)}
            >
              Prepare setup handoff
            </Button>
            <Button
              variant="outline"
              disabled={!available || pending}
              onClick={() => void operate("read")}
            >
              Check bridge status
            </Button>
          </div>
          {!management ? (
            <p className="text-sm text-muted-foreground">
              Bridge management is not wired in this build. Preparing a handoff does not grant
              access or connect Grok Bot.
            </p>
          ) : null}
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
          {error ? (
            <p role="alert" className="text-sm">
              {error}
            </p>
          ) : null}
          <div className="text-sm">
            {activeConnection ? (
              <p>
                Caller: {connection.callerId} · Last verified: {connection.verifiedAt}
              </p>
            ) : null}
            <h4 className="font-medium">Allowed projects / actions</h4>
            <p>
              {activeConnection
                ? `${connection.grant.projectIds.join(", ") || "None"} / ${connection.grant.actions.join(", ") || "None"}`
                : "No verified permissions."}
            </p>
            <h4 className="mt-3 font-medium">Current supervised tasks</h4>
            {activeConnection ? (
              <ul>
                {connection.tasks
                  .filter(
                    (task) =>
                      task.supervisorId === connection.callerId &&
                      connection.grant.projectIds.includes(task.projectId),
                  )
                  .map((task) => (
                    <li key={task.taskId}>
                      {task.taskId} — {task.state}
                      {task.runId ? ` · run ${task.runId}` : " · no run started"}
                    </li>
                  ))}
              </ul>
            ) : (
              <p>Unavailable until the bridge confirms supervision.</p>
            )}
            {activeConnection && connection.tasks.length === 0 ? (
              <p>No supervised tasks reported.</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={
                !available ||
                pending ||
                !connection ||
                connection.status === "revoked" ||
                connection.status === "disconnected"
              }
              onClick={() => void operate("revoke")}
            >
              Revoke controller access
            </Button>
            <Button
              variant="outline"
              disabled={
                !available || pending || !connection || connection.status === "disconnected"
              }
              onClick={() => void operate("disconnect")}
            >
              Disconnect controller
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Revocation blocks new controller actions; it does not claim to cancel a running task.
            Disconnect must be confirmed by the bridge.
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
