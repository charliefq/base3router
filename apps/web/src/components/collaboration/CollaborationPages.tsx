import { SelectionBasisReadout } from "./SelectionBasisReadout";
import { TaskResultFeedback } from "./TaskResultFeedback";
import { useAtomValue } from "@effect/atom-react";
import {
  type CollaborationCommand,
  type CollaborationCommandResult,
  type CollaborationOpenThreadInput,
  type CollaborationSnapshot,
  type CollaborationTask,
  type CollaborationTaskRoutingReadout,
  type CollaborationTaskResultReadout,
  type CollaborationTaskBudgetReadout,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { buildAgentDirectory, providerExecutable } from "./agentDirectory";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { isElectron } from "../../env";
import { runPrimaryHttp } from "../../lib/runtime";
import { usePreparedConnection } from "../../state/session";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { TaskRevisionRequest } from "./TaskRevisionRequest";
import { TaskFirstInstructions } from "./TaskFirstInstructions";
import { TaskReviewControls } from "./TaskReviewControls";
import { AgentsTaskCreator } from "./AgentsTaskCreator";
import { randomUUID } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BotIcon, PlusIcon, PlugIcon } from "lucide-react";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const budgetIssueLabels: Readonly<Record<string, string>> = {
  paused: "Paused for revised instructions",
  accepted: "Current revision already accepted",
  start_exhausted: "Reserved start limit exhausted",
  required_bound_missing: "Required frozen budget bound missing",
  deadline_expired: "Frozen deadline expired",
  usage_incomplete: "Task tree usage coverage incomplete",
  unverified_price: "Price evidence unverified",
  token_exhausted: "Frozen token budget exhausted",
  cost_exhausted: "Frozen dollar budget exhausted",
  unsettled_reservation: "Reservation not settled by complete verified usage",
};

function TaskBudgetReadout({
  readout,
  stale,
}: {
  readout: CollaborationTaskBudgetReadout | undefined;
  stale: boolean;
}) {
  const amount = (value: number | null) => (value === null ? "Unknown" : String(value));
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border/50 p-3">
      <h3 className="text-sm font-medium">Task tree budget evidence</h3>
      {stale ? (
        <p className="text-xs text-muted-foreground">
          Stale budget evidence — refresh has not confirmed current facts.
        </p>
      ) : null}
      {readout?.status === "available" ? (
        <>
          <p className="text-xs text-muted-foreground">
            Root {readout.rootThreadId} · contract revision {readout.contractRevision} · observed{" "}
            {readout.observedAt}
          </p>
          <dl className="space-y-1 text-xs text-muted-foreground">
            <div>
              <dt>Reserved provider starts / declared limit / remaining</dt>
              <dd>
                {readout.reservedStarts} / {readout.declaredStarts} / {readout.remainingStarts}
              </dd>
            </div>
            <div>
              <dt>Declared token / cost (USD) / deadline bounds</dt>
              <dd>
                {readout.declared.tokens ?? "Not declared"} /{" "}
                {readout.declared.costUsd ?? "Not declared"} /{" "}
                {readout.declared.deadline ?? "Not declared"}
              </dd>
            </div>
            <div>
              <dt>Frozen token / cost (USD) / deadline bounds</dt>
              <dd>
                {readout.frozen
                  ? `${readout.frozen.tokens ?? "No frozen token cap"} / ${readout.frozen.costUsd ?? "No frozen cost cap"} / ${readout.frozen.deadline} (frozen ${readout.frozen.frozenAt})`
                  : "Unknown — no persisted frozen bounds"}
              </dd>
            </div>
            <div>
              <dt>
                Reported tree usage ({readout.usage.status}; {readout.usage.attempts} attempts)
              </dt>
              <dd>
                {amount(readout.usage.reportedTokens)} tokens /{" "}
                {amount(readout.usage.reportedCostUsd)} USD
              </dd>
            </div>
            <div>
              <dt>Price evidence</dt>
              <dd>
                {readout.usage.priceStatus === "synthetic_verified"
                  ? "Verified synthetic fixture only"
                  : readout.usage.priceStatus === "no_attempts"
                    ? "No reported attempts; no production price verified"
                    : "Unverified — reported cost is not verified pricing"}
              </dd>
            </div>
            <div>
              <dt>Token remaining / verified dollar headroom (USD)</dt>
              <dd>
                {amount(readout.usage.remainingTokens)} /{" "}
                {amount(readout.usage.verifiedRemainingCostUsd)}
              </dd>
            </div>
            <div>
              <dt>Observed budget issues</dt>
              <dd>
                {readout.issues.length
                  ? readout.issues
                      .map(
                        (issue) =>
                          `${budgetIssueLabels[issue] ?? "Unknown budget issue"} (${issue})`,
                      )
                      .join(", ")
                  : "None observed in this snapshot"}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Budget evidence unknown: {readout?.reason ?? "not provided in this snapshot"}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Reservations are not confirmed execution. Partial totals do not establish remaining budget.
        Unset bounds do not mean unlimited budget. This snapshot grants no execution permission;
        dispatch rechecks policy. A cancellation request does not prove work stopped, and a turn may
        exceed a remaining consumption cap.
      </p>
    </div>
  );
}

const routingUnknownReason = (reason: string | null) => {
  switch (reason) {
    case "route_only":
      return "No correlated runtime run is recorded.";
    case "missing_attempt":
      return "No active run attempt is recorded.";
    case "missing_provider_turn":
      return "No matching provider turn is recorded.";
    case "provider_turn_pending":
      return "The matching provider turn is still pending.";
    case "provider_turn_not_started":
      return "The matching provider turn has no valid start evidence.";
    default:
      return "Persisted evidence is missing or inconsistent.";
  }
};

function TaskRoutingReadout({ readout }: { readout: CollaborationTaskRoutingReadout | undefined }) {
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border/50 p-3">
      <h3 className="text-sm font-medium">Routing evidence</h3>
      {readout?.status === "available" ? (
        <>
          <dl className="space-y-2 text-sm">
            <div>
              <dt>Mode</dt>
              <dd>
                {readout.mode === null
                  ? "Mode not recorded"
                  : readout.mode === "auto"
                    ? "Auto"
                    : "Manual"}
              </dd>
            </div>
            <div>
              <dt>Selected model</dt>
              <dd>
                {readout.selected
                  ? `${readout.selected.model} (${readout.selected.instanceId})`
                  : "Unknown — no valid route for this message"}
              </dd>
            </div>
            <div>
              <dt>Routing source</dt>
              <dd>{readout.source ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Routing reason</dt>
              <dd>
                {readout.explanation ??
                  (readout.reasons.length ? readout.reasons.join(", ") : "Not recorded")}
              </dd>
            </div>
            <div>
              <dt>Runtime model (configured)</dt>
              <dd>
                {readout.configuredModel
                  ? `${readout.configuredModel.model} (${readout.configuredModel.instanceId})`
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          <SelectionBasisReadout basis={readout.selectionBasis} />
          <p className="text-xs text-muted-foreground">
            The configured runtime model is not provider-attested.
          </p>
          <p className="text-sm">
            Execution evidence:{" "}
            {readout.execution.status === "observed" ? "Provider-turn start recorded" : "Unknown"}
          </p>
          {readout.execution.status === "observed" ? (
            <p className="break-all text-xs text-muted-foreground">
              Turn {readout.execution.providerTurnId}; status {readout.execution.providerStatus};
              started {readout.execution.startedAt}.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {routingUnknownReason(readout.execution.reason)}
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            Message {readout.messageId}; run {readout.runId ?? "not recorded"}.
          </p>
          <p className="text-xs text-muted-foreground">
            Terminal execution is not owner acceptance.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Routing evidence is unavailable; no valid persisted dispatch evidence can be confirmed.
        </p>
      )}
    </div>
  );
}

const resultUnknownReason = (reason: string) => {
  switch (reason) {
    case "run_turn_disagreement":
      return "The persisted run, attempt and turn states differ; completion is not confirmed.";
    case "provider_turn_not_started":
      return "A matching provider-turn start is not recorded.";
    case "no_completed_result":
      return "The matched run and turn do not have confirmed completion evidence.";
    case "result_not_complete_or_retry":
      return "The latest item is unfinished, streaming, empty or a retry record.";
    case "no_attributable_output":
      return "No matching assistant output or terminal-failure record is stored.";
    default:
      return "Matching persisted evidence is missing or inconsistent.";
  }
};

function TaskResultReadout({ readout }: { readout: CollaborationTaskResultReadout | undefined }) {
  return (
    <div className="mt-4 space-y-2 rounded-lg border border-border/50 p-3">
      <h3 className="text-sm font-medium">Result evidence</h3>
      {readout?.status === "available" ? (
        <>
          <p className="text-sm">Latest persisted run status: {readout.runStatus}</p>
          <p className="text-sm">
            Correlated provider-turn status: {readout.providerTurnStatus ?? "Unknown"}
          </p>
          {readout.modelIdentity ? (
            <p className="text-sm">
              Requested model: {readout.modelIdentity.requested}; resolved model:{" "}
              {readout.modelIdentity.resolved ?? "Unknown (not reported)"}
            </p>
          ) : null}
          {readout.content.status === "output" ? (
            <>
              <h4 className="text-sm font-medium">Latest persisted assistant output</h4>
              <pre className="whitespace-pre-wrap break-all text-sm">{readout.content.preview}</pre>
            </>
          ) : readout.content.status === "failure" ? (
            <>
              <h4 className="text-sm font-medium">Persisted terminal failure</h4>
              <p className="text-xs text-muted-foreground">
                Class: {readout.content.failure.class}; code:{" "}
                {readout.content.failure.code ?? "not recorded"}
              </p>
              <pre className="whitespace-pre-wrap break-all text-sm">
                {readout.content.failure.message}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No attributable completed output or terminal failure is confirmed.{" "}
              {resultUnknownReason(readout.content.reason)}
            </p>
          )}
          {readout.content.status !== "unknown" && readout.content.truncated ? (
            <p className="text-xs text-muted-foreground">
              Preview truncated; inspect the conversation for more context.
            </p>
          ) : null}
          <p className="break-all text-xs text-muted-foreground">
            Run {readout.runId}; message {readout.messageId}; attempt{" "}
            {readout.attemptId ?? "not confirmed"}; turn {readout.providerTurnId ?? "not confirmed"}
            {readout.content.status !== "unknown" ? `; item ${readout.content.itemId}` : ""}.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No validated persisted result evidence is available in this snapshot.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Persisted status and output do not establish a final answer or owner acceptance. Opening the
        conversation grants no execution.
      </p>
    </div>
  );
}

const loadSnapshot = () =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.snapshot({ headers: {} })),
    ),
  );

const sendCommand = (payload: CollaborationCommand) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.command({ headers: {}, payload })),
    ),
  );

const recoverThread = (payload: CollaborationOpenThreadInput) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.collaboration.openThread({ headers: {}, payload })),
    ),
  );

function useCollaboration(environmentId: EnvironmentId | null) {
  const session = Option.getOrNull(usePreparedConnection(environmentId));
  // Identity changes invalidate even A → B → A and re-pairing on the same server.
  const context = useMemo(
    () => Object.freeze({ environmentId, session }),
    [environmentId, session],
  );
  const currentContext = useRef<typeof context | null>(null);
  const [loaded, setLoaded] = useState<{
    context: typeof context;
    snapshot: CollaborationSnapshot;
    version: number;
  } | null>(null);
  const [readState, setReadState] = useState({
    context,
    error: null as string | null,
    refreshing: false,
    fresh: false,
  });
  const [pendingContext, setPendingContext] = useState<typeof context | null>(null);
  const setError = useCallback(
    (error: string | null) => setReadState((state) => ({ ...state, context, error })),
    [context],
  );
  const setRefreshing = useCallback(
    (refreshing: boolean) => setReadState((state) => ({ ...state, context, refreshing })),
    [context],
  );
  const setFresh = useCallback(
    (fresh: boolean) => setReadState((state) => ({ ...state, context, fresh })),
    [context],
  );
  const setPending = useCallback(
    (pending: boolean) => setPendingContext(pending ? context : null),
    [context],
  );
  const freshness = useRef(false);
  const readGeneration = useRef(0);
  const readOwner = useRef<{ explicit: boolean } | null>(null);
  const operationOwner = useRef<object | null>(null);
  useLayoutEffect(() => {
    currentContext.current = context;
    readGeneration.current += 1;
    readOwner.current = null;
    operationOwner.current = null;
    freshness.current = false;
    return () => {
      currentContext.current = null;
      readGeneration.current += 1;
      freshness.current = false;
    };
  }, [context]);

  const isCurrent = useCallback(
    () => currentContext.current === context && !!environmentId && session !== null,
    [context, environmentId, session],
  );
  const canOperate = () => isCurrent() && freshness.current;
  const read = useCallback(
    (explicit = false) => {
      if (!isCurrent() || (explicit && readOwner.current?.explicit)) return;
      const owner = { explicit };
      readOwner.current = owner;
      const generation = ++readGeneration.current;
      freshness.current = false;
      setReadState((state) => ({
        context,
        error: state.context === context ? state.error : null,
        fresh: false,
        refreshing: explicit,
      }));
      const ownsRead = () => isCurrent() && generation === readGeneration.current;
      return loadSnapshot()
        .then(
          (snapshot) => {
            if (!ownsRead()) return undefined;
            if (snapshot.environmentId !== undefined && snapshot.environmentId !== environmentId) {
              setError(
                "The response belongs to another environment. Refresh the selected environment.",
              );
              return undefined;
            }
            setLoaded({ context, snapshot, version: generation });
            setError(null);
            freshness.current = true;
            setFresh(true);
            return snapshot;
          },
          (cause) => {
            if (ownsRead())
              setError(
                cause instanceof Error ? cause.message : "The agent directory could not be read.",
              );
            return undefined;
          },
        )
        .finally(() => {
          if (ownsRead() && readOwner.current === owner) {
            readOwner.current = null;
            setRefreshing(false);
          }
        });
    },
    [context, environmentId, isCurrent, setError, setFresh, setRefreshing],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const execute = useCallback(
    async (
      request: () => Promise<CollaborationCommandResult>,
      acceptsResult: () => boolean = () => true,
    ) => {
      if (!isCurrent() || !freshness.current || operationOwner.current) return null;
      const owner = {};
      operationOwner.current = owner;
      const generation = readGeneration.current;
      const ownsOperation = () => isCurrent() && operationOwner.current === owner;
      setPending(true);
      try {
        const result = await request();
        if (!ownsOperation() || !acceptsResult()) return null;
        if (generation === readGeneration.current) {
          if (
            result.snapshot.environmentId !== undefined &&
            result.snapshot.environmentId !== environmentId
          ) {
            freshness.current = false;
            setFresh(false);
            setError(
              "The response belongs to another environment. Refresh the selected environment.",
            );
            return null;
          }
          setLoaded({ context, snapshot: result.snapshot, version: generation });
          setError(result.outcome === "rejected" ? result.detail : null);
        }
        // A mutation receipt remains a fact; a newer GET owns directory freshness.
        return result;
      } catch (cause) {
        if (ownsOperation() && acceptsResult() && generation === readGeneration.current)
          setError(cause instanceof Error ? cause.message : "The command was not recorded.");
        return null;
      } finally {
        if (ownsOperation()) {
          operationOwner.current = null;
          setPending(false);
        }
      }
    },
    [context, environmentId, isCurrent, setError, setFresh, setPending],
  );

  const invalidateReads = useCallback(() => {
    if (isCurrent()) {
      readGeneration.current += 1;
      readOwner.current = null;
      setRefreshing(false);
      freshness.current = false;
      setFresh(false);
    }
  }, [isCurrent, setRefreshing, setFresh]);

  return {
    refresh: () => read(true),
    refreshing: readState.context === context && readState.refreshing,
    fresh: loaded?.context === context && readState.context === context && readState.fresh,
    canOperate,
    captureRead:
      (generation = readGeneration.current) =>
      () =>
        isCurrent() && generation === readGeneration.current,
    isCurrent,
    connected: !!environmentId && session !== null,
    context,
    readVersion: loaded?.context === context ? loaded.version : 0,
    invalidateReads,
    snapshot: loaded?.context === context ? loaded.snapshot : null,
    error: readState.context === context ? readState.error : null,
    pending: pendingContext === context,
    submit: (command: CollaborationCommand) => execute(() => sendCommand(command)),
    open: (input: CollaborationOpenThreadInput, acceptsResult: () => boolean) =>
      execute(() => recoverThread(input), acceptsResult),
  };
}

export function AgentsPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const {
    snapshot,
    error,
    pending,
    open,
    refresh,
    refreshing,
    fresh,
    canOperate,
    captureRead,
    readVersion,
    isCurrent,
    connected,
    invalidateReads,
    context: directoryContext,
  } = useCollaboration(environmentId);
  const [creationRequest, setCreationRequest] = useState<{
    providerId: string;
    token: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showAgentCreation, setShowAgentCreation] = useState(false);
  const [newAgentChoice, setNewAgentChoice] = useState<{
    environmentId: typeof environmentId;
    providerId: string;
  } | null>(null);
  const newAgentProviderId =
    newAgentChoice && newAgentChoice.environmentId === environmentId
      ? newAgentChoice.providerId
      : null;
  const creationOwner = useRef<string | null>(null);
  const lockCreation = useCallback((owner: string) => {
    creationOwner.current = owner;
    setCreating(true);
  }, []);
  const releaseCreation = useCallback((owner: string) => {
    if (creationOwner.current !== owner) return;
    creationOwner.current = null;
    setCreating(false);
    setCreationRequest(null);
  }, []);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    environmentId: EnvironmentId;
    connection: typeof directoryContext;
    projectId: string;
    message: string;
  } | null>(null);
  const [openingContext, setOpeningContext] = useState<symbol | null>(null);
  const openingRef = useRef<object | null>(null);
  const taskReadOwner = useRef<object | null>(null);
  const selectedProject =
    projects.length === 1 ? projects[0] : projects.find((project) => project.id === projectId);
  const selectedProjectId = selectedProject?.id;
  const providerContext = providers
    .map((provider) => `${provider.instanceId}:${providerExecutable(provider)}`)
    .join(";");
  const [openScope, setOpenScope] = useState({
    connection: directoryContext,
    projectId: selectedProjectId,
    providers: providerContext,
    token: Symbol(),
  });
  if (
    openScope.connection !== directoryContext ||
    openScope.projectId !== selectedProjectId ||
    openScope.providers !== providerContext
  ) {
    // Keep a distinct operation epoch even when a project/provider is removed and restored.
    setOpenScope({
      connection: directoryContext,
      projectId: selectedProjectId,
      providers: providerContext,
      token: Symbol(),
    });
  }
  const [taskScope, setTaskScope] = useState({
    connection: directoryContext,
    projectId: selectedProjectId,
    token: Symbol(),
  });
  if (taskScope.connection !== directoryContext || taskScope.projectId !== selectedProjectId) {
    setTaskScope({ connection: directoryContext, projectId: selectedProjectId, token: Symbol() });
  }
  const [taskOpeningScope, setTaskOpeningScope] = useState<typeof taskScope | null>(null);
  const opening = openingContext === openScope.token || taskOpeningScope === taskScope;
  const navigationEpoch = useRef(taskScope);
  useLayoutEffect(() => {
    navigationEpoch.current = taskScope;
  }, [taskScope]);
  const context = useRef({
    environmentId,
    projectId: selectedProjectId,
    mounted: true,
    providers,
    connection: directoryContext,
    providerContext,
  });
  useLayoutEffect(() => {
    if (
      context.current.connection !== directoryContext ||
      context.current.projectId !== selectedProjectId ||
      (context.current.providerContext !== providerContext && !taskReadOwner.current)
    ) {
      // Retire only UI ownership; a server mutation may already have committed.
      if (taskReadOwner.current) {
        invalidateReads();
        taskReadOwner.current = null;
      }
      openingRef.current = null;
    }
    context.current = {
      environmentId,
      projectId: selectedProjectId,
      mounted: true,
      providers,
      connection: directoryContext,
      providerContext,
    };
    return () => {
      context.current.mounted = false;
    };
  }, [
    context,
    environmentId,
    selectedProjectId,
    providers,
    directoryContext,
    providerContext,
    invalidateReads,
  ]);

  const openThread = (threadId: string) => {
    if (!environmentId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const openAgent = async (agentId: string) => {
    // A ref closes the same-render double-click window before React updates disabled.
    if (
      !canOperate() ||
      error ||
      openingRef.current ||
      creationOwner.current !== null ||
      !snapshot ||
      !environmentId ||
      !selectedProject ||
      !context.current.mounted ||
      context.current.environmentId !== environmentId ||
      context.current.projectId !== selectedProject.id
    )
      return;
    const owner = {};
    const ownsRead = captureRead();
    const ownsOpen = () =>
      isCurrent() &&
      openingRef.current === owner &&
      context.current.mounted &&
      context.current.projectId === selectedProject.id;
    setNotice(null);
    const showNotice = (message: string) => {
      if (!ownsOpen()) return;
      setNotice({
        environmentId,
        connection: directoryContext,
        projectId: selectedProject.id,
        message,
      });
    };
    const bound = snapshot.agents.find(
      (agent) => agent.id === agentId && agent.projectId === selectedProject.id,
    );
    if (agentId === "grokbot" || bound?.origin === "external") return;
    const provider = context.current.providers.find((item) => item.instanceId === agentId);
    if (!provider || !providerExecutable(provider)) return;
    openingRef.current = owner;
    setOpeningContext(openScope.token);
    try {
      const linked = await open(
        { projectId: selectedProject.id, providerId: agentId },
        () => ownsOpen() && ownsRead(),
      );
      if (!ownsOpen() || !ownsRead()) return;
      if (!linked || linked.outcome === "rejected") {
        showNotice(
          linked?.detail ??
            "The conversation could not be confirmed. Retry this project to recover it.",
        );
        return;
      }
      const threadId = linked.snapshot.agents.find(
        (agent) => agent.id === agentId && agent.projectId === selectedProject.id,
      )?.threadId;
      if (!threadId) {
        showNotice("The conversation has no valid thread link. Explicit repair is required.");
        return;
      }
      if (
        ownsOpen() &&
        canOperate() &&
        context.current.environmentId === environmentId &&
        context.current.projectId === selectedProject.id &&
        context.current.providers.some(
          (item) => item.instanceId === agentId && providerExecutable(item),
        )
      )
        openThread(threadId);
    } catch {
      showNotice(
        "The conversation could not be confirmed. Retry in this project to recover the same request.",
      );
    } finally {
      if (ownsOpen()) {
        openingRef.current = null;
        setOpeningContext(null);
      }
    }
  };

  // A disabled render still displays the previous snapshot, never the active GET generation.
  const ownsDisplayedRead = captureRead(readVersion);
  const openTask = async (task: CollaborationTask, agentId: string) => {
    if (
      !canOperate() ||
      !ownsDisplayedRead() ||
      error ||
      pending ||
      openingRef.current ||
      creationOwner.current !== null ||
      !snapshot ||
      !environmentId ||
      !selectedProject ||
      navigationEpoch.current !== taskScope ||
      !context.current.mounted ||
      context.current.environmentId !== environmentId ||
      context.current.projectId !== selectedProject.id ||
      task.projectId !== selectedProject.id ||
      !task.threadId ||
      (task.ownerAgentId !== agentId && task.assigneeAgentId !== agentId)
    )
      return;
    // Freeze the displayed identity. A new binding must require another explicit click.
    const target = {
      id: task.id,
      projectId: task.projectId,
      threadId: task.threadId,
      ownerAgentId: task.ownerAgentId,
      assigneeAgentId: task.assigneeAgentId,
    };
    const owner = {};
    const ownsOpen = () =>
      isCurrent() &&
      openingRef.current === owner &&
      context.current.mounted &&
      navigationEpoch.current === taskScope &&
      context.current.environmentId === environmentId &&
      context.current.projectId === target.projectId;
    openingRef.current = owner;
    taskReadOwner.current = owner;
    setTaskOpeningScope(taskScope);
    setNotice(null);
    const showNotice = (message: string) => {
      if (ownsOpen())
        setNotice({
          environmentId,
          connection: directoryContext,
          projectId: target.projectId,
          message,
        });
    };
    try {
      // read() claims its generation synchronously, before a second click can enter.
      const request = refresh();
      const ownsRead = captureRead();
      const current = await request;
      if (!ownsOpen() || !ownsRead()) return;
      if (!current) {
        showNotice(
          "The task conversation could not be confirmed. Refresh the directory and try again.",
        );
        return;
      }
      const matches = current.tasks.filter((item) => item.id === target.id);
      const verified = matches.length === 1 ? matches[0] : undefined;
      if (
        current.environmentId !== environmentId ||
        !verified ||
        verified.projectId !== target.projectId ||
        verified.threadId !== target.threadId ||
        verified.ownerAgentId !== target.ownerAgentId ||
        verified.assigneeAgentId !== target.assigneeAgentId
      ) {
        showNotice(
          "The task conversation link changed or is no longer valid. Review the directory before opening it again.",
        );
        return;
      }
      if (ownsOpen() && ownsRead() && canOperate()) openThread(target.threadId);
    } finally {
      if (ownsOpen()) {
        openingRef.current = null;
        taskReadOwner.current = null;
        setTaskOpeningScope(null);
      }
    }
  };

  const directory = buildAgentDirectory({
    environmentId,
    projectId: selectedProjectId ?? null,
    source: { environmentId, providers, snapshot },
  });
  const grokbot = snapshot?.agents.find((agent) => agent.id === "grokbot");
  const visibleNotice =
    notice?.connection === directoryContext &&
    notice.environmentId === environmentId &&
    notice.projectId === selectedProjectId
      ? notice.message
      : null;
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Agents</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1">
        <ScrollArea radius="none">
          <WorkspacePageContainer width="wide">
            <section
              className="mx-auto flex max-w-2xl flex-col items-center gap-5 py-10 text-center sm:py-16"
              aria-labelledby="agents-heading"
            >
              <div
                className="flex size-20 items-center justify-center rounded-full bg-muted"
                aria-hidden="true"
              >
                <BotIcon className="size-9" />
              </div>
              <h2 id="agents-heading" className="text-3xl font-semibold tracking-tight sm:text-4xl">
                Build agents for your work
              </h2>
              <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                Choose a provider, open a project conversation, and give your agent a governed task.
                Follow its execution and results in Tasks.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Button
                  onClick={() => setShowAgentCreation(true)}
                  aria-expanded={showAgentCreation}
                  aria-controls="create-agent"
                >
                  <PlusIcon />
                  Create agent
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/providers" })}
                >
                  <PlugIcon />
                  Connect your agent
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Runs use your configured provider and existing approval controls.
              </p>
            </section>
            {showAgentCreation ? (
              <section
                id="create-agent"
                aria-label="Create agent"
                className="mx-auto mb-6 flex w-full max-w-xl flex-col gap-4 rounded-xl border border-border bg-card p-5"
              >
                <div>
                  <h3 className="font-medium">Create an agent conversation</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Select a ready provider below and a project. Creating the conversation does not
                    start provider work.
                  </p>
                </div>
                <label htmlFor="new-agent-provider" className="text-sm font-medium">
                  Provider
                </label>
                <Select
                  value={newAgentProviderId ?? ""}
                  items={[
                    { value: "", label: "Select a provider" },
                    ...providers.filter(providerExecutable).map((provider) => ({
                      value: provider.instanceId,
                      label: provider.displayName ?? provider.instanceId,
                    })),
                  ]}
                  onValueChange={(value) =>
                    setNewAgentChoice(value ? { environmentId, providerId: value } : null)
                  }
                >
                  <SelectTrigger id="new-agent-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">Select a provider</SelectItem>
                    {providers.filter(providerExecutable).map((provider) => (
                      <SelectItem key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName ?? provider.instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {!providers.some(providerExecutable) ? (
                  <p className="text-sm text-muted-foreground">
                    No provider is ready. Connect your agent to configure a supported provider.
                  </p>
                ) : null}
                {!selectedProject ? (
                  <p className="text-sm text-muted-foreground">
                    Select a project in the directory below to continue.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Project: {selectedProject.title}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      !newAgentProviderId ||
                      !providers.some(
                        (provider) =>
                          provider.instanceId === newAgentProviderId &&
                          providerExecutable(provider),
                      ) ||
                      !selectedProject ||
                      !fresh ||
                      !snapshot ||
                      !!error ||
                      pending ||
                      opening ||
                      creating
                    }
                    onClick={() => {
                      if (newAgentProviderId) void openAgent(newAgentProviderId);
                    }}
                  >
                    Create agent conversation
                  </Button>
                  <Button
                    variant="outline"
                    disabled={opening || creating || pending}
                    onClick={() => setShowAgentCreation(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            ) : null}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                Internal providers and external agents. Open a conversation in its project; opening
                a conversation does not start execution.
              </p>
              {projects.length > 1 ? (
                <div className="flex w-full flex-col gap-2 sm:w-64 sm:shrink-0">
                  <label htmlFor="agents-project" className="text-sm font-medium">
                    Project
                  </label>
                  <Select
                    disabled={opening}
                    value={projectId ?? ""}
                    items={[
                      { value: "", label: "Select a project" },
                      ...projects.map((project) => ({ value: project.id, label: project.title })),
                    ]}
                    onValueChange={(value) => setProjectId(value || null)}
                  >
                    <SelectTrigger id="agents-project">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">Select a project</SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : selectedProject ? (
                <div className="text-sm text-muted-foreground">
                  Project:{" "}
                  <span className="font-medium text-foreground">{selectedProject.title}</span>
                </div>
              ) : null}
            </div>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {visibleNotice ? (
              <Alert variant="warning">
                <AlertDescription>{visibleNotice}</AlertDescription>
              </Alert>
            ) : null}
            {!environmentId ? (
              <Alert variant="info">
                <AlertDescription>No primary environment is connected.</AlertDescription>
              </Alert>
            ) : projects.length === 0 ? (
              <Alert variant="info">
                <AlertDescription>
                  No project is open on this environment. An agent thread needs a real project.
                </AlertDescription>
              </Alert>
            ) : !selectedProject ? (
              <Alert variant="info">
                <AlertDescription>
                  Select a project to open or recover its agent conversations.
                </AlertDescription>
              </Alert>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!connected || refreshing}
              onClick={() => {
                void refresh();
              }}
            >
              {refreshing
                ? "Reading agent directory…"
                : error
                  ? "Retry agent directory"
                  : "Refresh agent directory"}
            </Button>
            {snapshot && !fresh ? (
              <p role="status" className="text-sm text-muted-foreground">
                Agent directory may be stale. Read the current directory before opening a
                conversation or creating a task.
              </p>
            ) : null}
            {environmentId && !snapshot && !error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading the agent directory.
              </p>
            ) : null}
            <h2 className="text-lg font-semibold">Your agents</h2>
            <ul
              aria-label="Agent directory"
              className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3"
            >
              {grokbot ? (
                <li className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h2 className="wrap-anywhere text-base font-medium">{grokbot.displayName}</h2>
                      <p className="text-xs text-muted-foreground">
                        {grokbot.origin} · {grokbot.role}
                      </p>
                    </div>
                    <Badge variant="secondary">NOT_CONNECTED</Badge>
                  </div>
                  <div className="mt-4 space-y-3 text-sm leading-relaxed">
                    <p className="text-muted-foreground">Availability: {grokbot.availability}</p>
                    <p className="wrap-anywhere text-muted-foreground">
                      Capabilities:{" "}
                      {grokbot.capabilities.join(", ") || "No advertised capabilities."}
                    </p>
                    <p>Grokbot is NOT_CONNECTED. No chat was opened.</p>
                    {snapshot?.grokbotIntegration.length ? (
                      <details className="text-muted-foreground">
                        <summary className="cursor-pointer text-foreground">
                          Connection requirements
                        </summary>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          {snapshot.grokbotIntegration.map((item) => (
                            <li key={item} className="wrap-anywhere">
                              {item}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    <Button aria-pressed={false} disabled size="sm" variant="outline">
                      Open conversation
                    </Button>
                  </div>
                </li>
              ) : null}
              {directory.map((entry) => {
                const { provider, saved: bound, tasks } = entry;
                const ready = entry.readiness === "ready";
                return (
                  <li
                    key={entry.id}
                    data-agent-id={entry.id}
                    className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {provider ? (
                          <ProviderInstanceIcon
                            driverKind={deriveProviderInstanceEntries([provider])[0]!.driverKind}
                            displayName={entry.displayName}
                            className="size-9"
                            iconClassName="size-9"
                          />
                        ) : (
                          <BotIcon className="size-9 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 space-y-1">
                          <h2 className="wrap-anywhere text-base font-medium">
                            {entry.displayName}
                          </h2>
                          <p className="text-xs text-muted-foreground">internal · provider</p>
                        </div>
                      </div>
                      <Badge variant="secondary">
                        {ready ? "Provider ready" : "Provider unavailable"}
                      </Badge>
                    </div>
                    <div className="mt-4 space-y-3 text-sm leading-relaxed">
                      <p className="text-muted-foreground">
                        Provider readiness: {ready ? "ready" : "unavailable"}
                      </p>
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Provider details</summary>
                        <p className="mt-2">
                          Saved ledger availability: {bound?.availability ?? "not recorded"}. Ledger
                          state does not confirm provider execution or owner acceptance.
                        </p>
                        <p className="mt-2 wrap-anywhere">
                          Capabilities:{" "}
                          {bound?.capabilities.join(", ") || "No advertised capabilities."}
                        </p>
                      </details>
                      {!provider ? (
                        <p className="text-muted-foreground">
                          Provider configuration is missing. The saved identity and task records
                          remain available.
                        </p>
                      ) : null}
                      <p className="wrap-anywhere">
                        {ready
                          ? `${
                              provider?.models
                                .slice(0, 3)
                                .map((model) => model.slug)
                                .join(", ") || "No model"
                            }${provider && provider.models.length > 3 ? ` · ${provider.models.length - 3} more models` : ""}`
                          : "This provider is not ready. No conversation was fabricated."}
                      </p>
                      <div className="space-y-1 border-t border-border/50 pt-3">
                        <h3 className="text-xs font-medium text-muted-foreground">Task ledger</h3>
                        {tasks.length ? (
                          <ul className="space-y-1">
                            {tasks.map((task) => (
                              <li key={`${task.projectId}:${task.id}`} className="wrap-anywhere">
                                {task.title} — ledger {task.state}
                                <div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    aria-label={`Open task: ${task.title}`}
                                    disabled={
                                      opening ||
                                      creating ||
                                      pending ||
                                      !fresh ||
                                      !!error ||
                                      !task.threadId
                                    }
                                    onClick={() => {
                                      void openTask(task, entry.id);
                                    }}
                                  >
                                    Open task
                                  </Button>
                                  {!task.threadId ? (
                                    <p className="text-xs text-muted-foreground">
                                      This task has no valid conversation link. Explicit repair is
                                      required.
                                    </p>
                                  ) : null}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-muted-foreground">
                            {selectedProject
                              ? snapshot
                                ? "No recorded tasks."
                                : "Task records have not been read."
                              : "Select a project to view its tasks."}
                          </p>
                        )}
                      </div>
                      <Button
                        disabled={
                          opening ||
                          creating ||
                          pending ||
                          !fresh ||
                          !!error ||
                          !snapshot ||
                          !ready ||
                          !selectedProject
                        }
                        onClick={() => {
                          void openAgent(entry.id);
                        }}
                        size="sm"
                        variant="outline"
                        aria-label={`Open ${entry.displayName} conversation`}
                      >
                        Open conversation
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          opening ||
                          creating ||
                          pending ||
                          !snapshot ||
                          !fresh ||
                          !!error ||
                          !ready ||
                          !selectedProject
                        }
                        aria-label={`New ${entry.displayName} task`}
                        onClick={() => {
                          if (
                            !canOperate() ||
                            openingRef.current ||
                            creationOwner.current !== null ||
                            !snapshot ||
                            error ||
                            !environmentId ||
                            !selectedProject ||
                            !provider ||
                            !providerExecutable(provider) ||
                            !context.current.providers.some(
                              (p) => p.instanceId === entry.id && providerExecutable(p),
                            ) ||
                            !context.current.mounted ||
                            context.current.environmentId !== environmentId ||
                            context.current.projectId !== selectedProject.id
                          )
                            return;
                          const token = randomUUID();
                          lockCreation(token);
                          setCreationRequest({ providerId: entry.id, token });
                        }}
                      >
                        New task
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <AgentsTaskCreator
              environmentId={environmentId}
              project={selectedProject}
              providers={providers}
              request={creationRequest}
              onLock={lockCreation}
              onRelease={releaseCreation}
              refresh={async () => await refresh()}
              onOpen={(selectedEnvironment, threadId) => {
                if (
                  context.current.mounted &&
                  context.current.environmentId === selectedEnvironment &&
                  context.current.projectId === selectedProjectId
                )
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: selectedEnvironment, threadId },
                  });
              }}
            />
            {!providers.some(providerExecutable) && snapshot ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm leading-relaxed text-muted-foreground">
                <p>
                  {providers.length === 0
                    ? "No provider is configured. Saved agent and task records remain readable."
                    : "No provider is ready for task execution. Saved agent and task records remain readable. Check provider setup and authentication."}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/providers" })}
                >
                  Set up a provider
                </Button>
              </div>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function TasksPage() {
  const navigate = useNavigate();
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { snapshot, error, refresh, refreshing, fresh, canOperate, readVersion, invalidateReads } =
    useCollaboration(environmentId);
  const tasks = snapshot?.tasks ?? [];
  const [projectId, setProjectId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [creationRequest, setCreationRequest] = useState<{
    providerId: string;
    token: string;
  } | null>(null);
  const creationOwner = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);
  const selectedProject =
    projects.length === 1 ? projects[0] : projects.find((project) => project.id === projectId);
  const readyProviders = providers.filter(providerExecutable);
  const selectedProvider =
    readyProviders.find((provider) => provider.instanceId === providerId) ??
    (readyProviders.length === 1 ? readyProviders[0] : undefined);
  const lockCreation = (owner: string) => {
    creationOwner.current = owner;
    setCreating(true);
  };
  const releaseCreation = (owner: string) => {
    if (creationOwner.current !== owner) return;
    creationOwner.current = null;
    setCreating(false);
    setCreationRequest(null);
  };

  const openTask = (task: CollaborationTask) => {
    if (!environmentId || !task.threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: task.threadId },
    });
  };

  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Tasks</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1">
        <ScrollArea radius="none">
          <WorkspacePageContainer width="wide">
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Create a governed task, review its contract, then open its conversation to send
              instructions. Refresh to see recorded execution status and result evidence. Creating
              or opening a task does not start provider work.
            </p>
            <section
              aria-label="Create governed task"
              className="space-y-3 rounded-xl border border-border/60 p-4"
            >
              <h2 className="text-base font-medium">Create task</h2>
              {projects.length > 1 ? (
                <label className="block space-y-1 text-sm">
                  <span>Project</span>
                  <Select
                    value={projectId ?? ""}
                    onValueChange={(value) => setProjectId(value || null)}
                  >
                    <SelectTrigger aria-label="Task project">
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
              ) : selectedProject ? (
                <p className="text-sm">Project: {selectedProject.title}</p>
              ) : null}
              {readyProviders.length > 1 ? (
                <label className="block space-y-1 text-sm">
                  <span>Provider</span>
                  <Select
                    value={providerId ?? ""}
                    onValueChange={(value) => setProviderId(value || null)}
                  >
                    <SelectTrigger aria-label="Task provider">
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectPopup>
                      {readyProviders.map((provider) => (
                        <SelectItem key={provider.instanceId} value={provider.instanceId}>
                          {provider.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
              ) : selectedProvider ? (
                <p className="text-sm">Provider: {selectedProvider.displayName}</p>
              ) : null}
              {!selectedProject ? (
                <p className="text-sm text-muted-foreground">
                  Choose a project before creating a task.
                </p>
              ) : null}
              {readyProviders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No executable provider is ready. Configure and authenticate a supported provider
                  to create a task. Existing tasks remain readable.
                </p>
              ) : null}
              {readyProviders.length === 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/providers" })}
                >
                  Set up a provider
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={!fresh || !!error || creating || !selectedProject || !selectedProvider}
                onClick={() => {
                  if (
                    !canOperate() ||
                    creationOwner.current ||
                    !selectedProject ||
                    !selectedProvider
                  )
                    return;
                  const token = randomUUID();
                  lockCreation(token);
                  setCreationRequest({ providerId: selectedProvider.instanceId, token });
                }}
              >
                Create governed task
              </Button>
              <AgentsTaskCreator
                environmentId={environmentId}
                project={selectedProject}
                providers={providers}
                request={creationRequest}
                onLock={lockCreation}
                onRelease={releaseCreation}
                refresh={async () => await refresh()}
                onOpen={(selectedEnvironment, threadId) => {
                  if (environmentId === selectedEnvironment && selectedProject)
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId: selectedEnvironment, threadId },
                    });
                }}
              />
            </section>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={!environmentId || refreshing}
                onClick={() => {
                  void refresh();
                }}
              >
                {refreshing ? "Refreshing tasks…" : "Refresh tasks"}
              </Button>
            </div>
            {error ? (
              <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
                {snapshot ? (
                  <AlertDescription>
                    Task data may be stale. The read failed; showing the last successful task data.
                  </AlertDescription>
                ) : null}
              </Alert>
            ) : null}
            {!environmentId ? (
              <Alert variant="info">
                <AlertDescription>No primary environment is connected.</AlertDescription>
              </Alert>
            ) : !snapshot && !error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading cross-agent tasks.
              </p>
            ) : snapshot && tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                No cross-agent tasks yet.
              </div>
            ) : null}
            {tasks.length > 0 ? (
              <ul aria-label="Cross-agent tasks" className="space-y-4">
                {tasks.map((task) => (
                  <li
                    key={`${task.projectId}:${task.id}`}
                    className="min-w-0 rounded-xl border border-border/60 bg-card/40 p-5 shadow-xs/5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h2 className="min-w-0 wrap-anywhere text-base font-medium">{task.title}</h2>
                      <Badge variant="secondary">Command ledger: {task.state}</Badge>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      Provider activity and terminal outcomes, plus owner/reviewer acceptance,
                      require separate evidence. Contract phase and accepted revision are separate
                      contract records.
                    </p>
                    <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Owner</dt>
                        <dd className="wrap-anywhere">{task.ownerAgentId}</dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Assignee</dt>
                        <dd className="wrap-anywhere">{task.assigneeAgentId}</dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Wait reason</dt>
                        <dd className="wrap-anywhere leading-relaxed">
                          {task.waitReason ?? "No wait."}
                        </dd>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <dt className="text-xs text-muted-foreground">Task note</dt>
                        <dd className="wrap-anywhere leading-relaxed">{task.acceptance}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 space-y-2">
                      {task.contractReadout?.status === "available" ? (
                        <>
                          {environmentId ? (
                            <TaskReviewControls
                              key={`${environmentId}:${task.projectId}:${task.id}:${task.threadId}`}
                              task={task}
                              environmentId={environmentId}
                              readVersion={readVersion}
                              stale={error !== null || refreshing}
                              invalidateReads={invalidateReads}
                              refresh={async () => await refresh()}
                            />
                          ) : null}
                          <dl className="space-y-1 text-xs text-muted-foreground">
                            {task.contractReadout.contract.brake.maxTokens !== undefined ? (
                              <div>
                                <dt>Declared token cap</dt>
                                <dd>{task.contractReadout.contract.brake.maxTokens}</dd>
                              </div>
                            ) : null}
                            {task.contractReadout.contract.brake.maxCostUsd !== undefined ? (
                              <div>
                                <dt>Declared cost cap (USD)</dt>
                                <dd>{task.contractReadout.contract.brake.maxCostUsd}</dd>
                              </div>
                            ) : null}
                            {task.contractReadout.contract.brake.deadlineAt !== undefined ? (
                              <div>
                                <dt>Declared deadline</dt>
                                <dd>{task.contractReadout.contract.brake.deadlineAt}</dd>
                              </div>
                            ) : null}
                          </dl>
                          <p className="text-xs text-muted-foreground">
                            Stop conditions are recorded for human review; this card does not
                            enforce natural-language conditions.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {task.contractReadout === undefined
                            ? "Persisted contract readout is unavailable in this snapshot."
                            : task.contractReadout.reason === "ordinary_chat"
                              ? "Ordinary chat has no persisted task contract."
                              : task.contractReadout.reason === "missing_contract"
                                ? "The governed thread has no complete persisted contract."
                                : task.contractReadout.reason === "invalid_contract"
                                  ? "The stored contract is incomplete or unreadable; its fields cannot be confirmed."
                                  : "No valid linked conversation is available to read a persisted contract."}
                        </p>
                      )}
                    </div>
                    <TaskBudgetReadout
                      readout={task.budgetReadout}
                      stale={error !== null || refreshing}
                    />
                    <TaskRoutingReadout readout={task.routingReadout} />
                    <TaskResultReadout readout={task.resultReadout} />
                    {environmentId ? (
                      <TaskResultFeedback
                        task={task}
                        environmentId={environmentId}
                        stale={error !== null || refreshing}
                        readVersion={readVersion}
                      />
                    ) : null}
                    {environmentId ? (
                      <TaskRevisionRequest
                        task={task}
                        environmentId={environmentId}
                        stale={error !== null || refreshing}
                        readVersion={readVersion}
                        readCollaboration={loadSnapshot}
                        onOpen={() => openTask(task)}
                      />
                    ) : null}
                    <div className="mt-4 flex flex-col gap-3 border-t border-border/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                        <p>Gate {task.gateDecision}. This task does not grant execution.</p>
                        <p>
                          {task.threadId
                            ? "Opening this task returns to its project thread."
                            : "This task has no project thread."}
                        </p>
                      </div>
                      <div className="shrink-0 space-y-2">
                        {environmentId ? (
                          <TaskFirstInstructions
                            task={task}
                            environmentId={environmentId}
                            stale={error !== null || refreshing}
                            readVersion={readVersion}
                            onOpen={() => openTask(task)}
                          />
                        ) : null}
                        <Button
                          disabled={!task.threadId || !environmentId}
                          onClick={() => openTask(task)}
                          size="sm"
                          variant="outline"
                        >
                          Open conversation
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
