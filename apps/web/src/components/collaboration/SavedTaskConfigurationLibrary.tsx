import {
  AuthOrchestrationOperateScope,
  AgentProfile,
  AgentConfigurationSnapshot,
  ProjectId,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { configurationSnapshot } from "@t3tools/shared/agentConfiguration";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { workflowEnvironment } from "../../state/workflow";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSessionState, usePreparedConnection } from "../../state/session";
import { providerExecutable } from "./agentDirectory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export type SavedConfigurationSelection = {
  readonly configuration: AgentConfigurationSnapshot;
  // This capability is local UI freshness, never execution authority.
  readonly isCurrent: () => boolean;
};
const same = Schema.toEquivalence(AgentConfigurationSnapshot);
const validProfile = Schema.is(AgentProfile);
function configurations(
  profiles: ReadonlyArray<AgentProfile>,
  environmentId: EnvironmentId | null,
  projectId: string | undefined,
) {
  const latest = new Map<string, AgentProfile>();
  const ambiguous = new Set<string>();
  for (const profile of profiles) {
    if (
      !validProfile(profile) ||
      profile.projectId !== projectId ||
      profile.taskConfiguration?.environmentId !== environmentId
    )
      continue;
    const previous = latest.get(profile.id);
    if (
      previous?.version === profile.version &&
      JSON.stringify(previous) !== JSON.stringify(profile)
    )
      ambiguous.add(profile.id);
    if (!previous || previous.version < profile.version) latest.set(profile.id, profile);
  }
  return [...latest.values()].filter((p) => !ambiguous.has(p.id));
}
function unavailable(profile: AgentProfile, providers: ReadonlyArray<ServerProvider>) {
  if (profile.status !== "active")
    return "Archived configuration. Restore it in the configuration editor before reuse.";
  const selection = profile.taskConfiguration!.modelSelection;
  const provider = providers.find((p) => p.instanceId === selection.instanceId);
  if (!provider || !providerExecutable(provider))
    return `Provider ${selection.instanceId} is unavailable. No provider will be substituted.`;
  if (!provider.models.some((m) => m.slug === selection.model))
    return `Model ${selection.model} is unavailable. No model will be substituted.`;
  return null;
}
type Props = {
  environmentId: EnvironmentId | null;
  projectId: string | undefined;
  providers: ReadonlyArray<ServerProvider>;
  fresh: boolean;
  readVersion: number;
  disabled: boolean;
  canOperate: () => boolean;
  onRetire: () => void;
  onUse: (selection: SavedConfigurationSelection) => void;
};
export function SavedTaskConfigurationLibrary(props: Props) {
  return props.environmentId ? (
    <ScopedConfigurationLibrary {...props} environmentId={props.environmentId} />
  ) : (
    <section aria-label="Saved task configuration library">
      <h2>Saved task configurations</h2>
      <p>Connect an environment to inspect reusable task inputs.</p>
    </section>
  );
}
function ScopedConfigurationLibrary(props: Props & { environmentId: EnvironmentId }) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const access = useEnvironmentSessionState(props.environmentId);
  const canReuse =
    !access.hasError &&
    !access.isPending &&
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const accessRef = useRef(canReuse);
  useLayoutEffect(() => {
    accessRef.current = canReuse;
  }, [canReuse]);
  const read = useAtomCommand(workflowEnvironment.readCatalog, { reportFailure: false });
  const providerVersion = JSON.stringify(
    props.providers.map((p) => [p.instanceId, providerExecutable(p), p.models.map((m) => m.slug)]),
  );
  const [scope, setScope] = useState({
    environmentId: props.environmentId,
    projectId: props.projectId,
    session,
    fresh: props.fresh,
    readVersion: props.readVersion,
    providerVersion,
    canReuse,
  });
  if (
    scope.environmentId !== props.environmentId ||
    scope.projectId !== props.projectId ||
    scope.session !== session ||
    scope.fresh !== props.fresh ||
    scope.readVersion !== props.readVersion ||
    scope.providerVersion !== providerVersion ||
    scope.canReuse !== canReuse
  ) {
    // Retain a distinct epoch even when an observed value returns to its original value.
    setScope({
      environmentId: props.environmentId,
      projectId: props.projectId,
      session,
      fresh: props.fresh,
      readVersion: props.readVersion,
      providerVersion,
      canReuse,
    });
  }
  const current = useRef(scope);
  const latest = useRef(props);
  const generation = useRef(0);
  const mounted = useRef(false);
  const catalogIdentity = useRef<object | null>(null);
  const [loaded, setLoaded] = useState<{
    scope: object;
    profiles: ReadonlyArray<AgentProfile>;
  } | null>(null);
  const [inspection, setInspection] = useState<AgentProfile | null>(null);
  const inspectionRef = useRef(inspection);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const retire = useCallback(() => {
    generation.current++;
    inspectionRef.current = null;
    setInspection(null);
    latest.current.onRetire();
  }, []);
  const accepts = useCallback(
    (token: object, epoch: number) =>
      mounted.current && current.current === token && generation.current === epoch,
    [],
  );
  const load = useCallback(async () => {
    if (current.current !== scope) return;
    retire();
    catalogIdentity.current = null;
    setLoaded(null);
    setNotice(null);
    busyRef.current = false;
    setBusy(false);
    if (!scope.projectId || !scope.session || !scope.fresh) return;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await read({
        environmentId: scope.environmentId,
        input: { projectId: ProjectId.make(scope.projectId) },
      });
      if (!accepts(scope, epoch)) return;
      if (result._tag !== "Success") {
        setNotice("Saved task configurations could not be read. Refresh to try a read again.");
        return;
      }
      const catalog = {
        scope,
        profiles: configurations(result.value.profiles, scope.environmentId, scope.projectId),
      };
      catalogIdentity.current = catalog;
      setLoaded(catalog);
    } catch {
      if (accepts(scope, epoch))
        setNotice("Saved task configurations could not be read. No selection was substituted.");
    } finally {
      if (accepts(scope, epoch)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [scope, read, retire, accepts]);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    current.current = scope;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
    // Scope is an identity epoch, including A→B→A and authenticated session changes.
  }, [scope, load]);
  const profiles = loaded?.scope === scope ? loaded.profiles : [];
  const reason = inspection ? unavailable(inspection, props.providers) : null;
  const reuseReason =
    reason ??
    (!session || !props.fresh
      ? "Reconnect and refresh this environment before reuse."
      : !canReuse || !props.canOperate()
        ? "This connection cannot operate. Reuse requires an authorized writable session."
        : null);
  const reuse = async () => {
    const profile = inspection;
    if (
      !profile ||
      inspectionRef.current !== profile ||
      current.current !== scope ||
      busyRef.current ||
      props.disabled ||
      reuseReason ||
      !props.environmentId ||
      !props.projectId
    )
      return;
    const snapshot = configurationSnapshot(profile);
    if (!snapshot) return;
    const epoch = generation.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await read({
        environmentId: props.environmentId,
        input: { projectId: ProjectId.make(props.projectId) },
      });
      if (!accepts(scope, epoch) || inspectionRef.current !== profile) return;
      const exact =
        result._tag === "Success"
          ? configurations(result.value.profiles, props.environmentId, props.projectId).find(
              (p) => p.id === profile.id,
            )
          : undefined;
      const freshSnapshot = exact && configurationSnapshot(exact);
      if (
        !exact ||
        !freshSnapshot ||
        !same(snapshot, freshSnapshot) ||
        unavailable(exact, latest.current.providers)
      ) {
        retire();
        catalogIdentity.current = null;
        setLoaded(null);
        setNotice(
          "This configuration changed or became unavailable. Refresh and inspect the exact revision again.",
        );
        return;
      }
      const isCurrent = () =>
        accepts(scope, epoch) &&
        inspectionRef.current === profile &&
        latest.current.fresh &&
        accessRef.current &&
        latest.current.canOperate() &&
        !unavailable(exact, latest.current.providers);
      if (isCurrent()) latest.current.onUse({ configuration: snapshot, isCurrent });
    } catch {
      if (accepts(scope, epoch)) {
        retire();
        setNotice("Configuration reuse could not be verified. Refresh and inspect again.");
      }
    } finally {
      if (mounted.current && current.current === scope) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      aria-label="Saved task configuration library"
      className="space-y-3 rounded-xl border border-border p-4"
    >
      <h2>Saved task configurations</h2>
      <p>
        Reusable task inputs, not independently online agents. Inspect instructions and an exact
        model before preparing a new independent task. Reuse grants no execution permission.
      </p>
      <p>
        Environment: {props.environmentId ?? "disconnected"}. Project:{" "}
        {props.projectId ?? "select a project"}. Only configurations visible to the current
        authenticated owner in this scope are listed.
      </p>
      <Button type="button" disabled={!session || !props.fresh || !props.projectId} onClick={load}>
        Refresh saved task configurations
      </Button>
      {busy ? <p role="status">Reading saved task configurations…</p> : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {!props.fresh || !session ? (
        <p>Reconnect and refresh this environment to inspect its configurations.</p>
      ) : null}
      <Input
        aria-label="Find saved task configuration"
        placeholder="Find by name or identity"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {loaded?.scope === scope && profiles.length === 0 ? (
        <p>
          No saved task configurations in this scope. Save one in the task configuration editor.
        </p>
      ) : null}
      <ul>
        {profiles
          .filter((p) => `${p.displayName} ${p.id}`.toLowerCase().includes(search.toLowerCase()))
          .map((profile) => (
            <li key={profile.id}>
              <p>
                {profile.displayName} — revision {profile.version} — {profile.status}. Identity:{" "}
                {profile.id}. Provider: {profile.taskConfiguration!.modelSelection.instanceId}.
                Model: {profile.taskConfiguration!.modelSelection.model}.
              </p>
              <Button
                type="button"
                disabled={busy || !props.fresh || !session}
                aria-label={`Inspect configuration ${profile.displayName} ${profile.id} r${profile.version}`}
                onClick={() => {
                  if (
                    current.current !== scope ||
                    loaded?.scope !== scope ||
                    catalogIdentity.current !== loaded ||
                    busyRef.current ||
                    !latest.current.fresh
                  )
                    return;
                  retire();
                  inspectionRef.current = profile;
                  setInspection(profile);
                  setNotice(null);
                }}
              >
                Inspect configuration
              </Button>
            </li>
          ))}
      </ul>
      {inspection ? (
        <div aria-label="Configuration inspection">
          <h3>
            {inspection.displayName} — revision {inspection.version}
          </h3>
          <p>
            Identity: {inspection.id}. State: {inspection.status}. Provider:{" "}
            {inspection.taskConfiguration!.modelSelection.instanceId}. Exact model:{" "}
            {inspection.taskConfiguration!.modelSelection.model}.
          </p>
          <p>Complete stored instructions</p>
          <pre className="whitespace-pre-wrap break-words">{inspection.instructions}</pre>
          {reuseReason ? <p role="status">{reuseReason}</p> : null}
          <Button type="button" disabled={busy || props.disabled || !!reuseReason} onClick={reuse}>
            Use configuration
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (current.current === scope && inspectionRef.current === inspection) retire();
            }}
          >
            Cancel inspection
          </Button>
        </div>
      ) : null}
    </section>
  );
}
