import {
  createDispatcherPreviewController,
  type DispatcherPreviewState,
} from "@t3tools/client-runtime/dispatcher";
import {
  ActionApprovalId,
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type DispatcherRoutePreviewRequest,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkflowCatalog,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  INSPECTOR_OPEN_STORAGE_KEY,
  shouldCollapseInspector,
} from "~/controlPlane/productNavigation";
import { presentActionApproval } from "~/controlPlane/presentActionApproval";
import { presentOperationalInspector } from "~/controlPlane/presentOperationalInspector";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSession } from "~/state/session";
import { serverEnvironment } from "~/state/server";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useProject, useThreadDetail, useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { dispatcherEnvironment } from "~/state/dispatcher";
import { workflowEnvironment } from "~/state/workflow";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";

import { OperationalInspector } from "./OperationalInspector";

const IDLE_PREVIEW: DispatcherPreviewState = { status: "idle" };

const EMPTY_SESSION_STATE_ATOM = Atom.make<AuthSessionState | null>(null).pipe(
  Atom.withLabel("web-inspector-session-empty"),
);

function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function OperationalInspectorHost(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
}) {
  const viewportWidth = useSyncExternalStore(subscribeViewport, () => window.innerWidth);
  const [userOpen, setUserOpen] = useState(() => {
    try {
      return (
        getLocalStorageItem(INSPECTOR_OPEN_STORAGE_KEY, Schema.Boolean) ??
        !shouldCollapseInspector(window.innerWidth)
      );
    } catch {
      return !shouldCollapseInspector(window.innerWidth);
    }
  });
  const collapsed = !userOpen;
  const wasNarrow = useRef(shouldCollapseInspector(viewportWidth));
  useEffect(() => {
    const narrow = shouldCollapseInspector(viewportWidth);
    if (narrow && !wasNarrow.current) setUserOpen(false);
    wasNarrow.current = narrow;
  }, [viewportWidth]);

  const environment = useEnvironment(props.environmentId);
  const projectRef =
    props.environmentId && props.projectId
      ? scopeProjectRef(props.environmentId, props.projectId)
      : null;
  const threadRef =
    props.environmentId && props.threadId
      ? scopeThreadRef(props.environmentId, props.threadId)
      : null;
  const project = useProject(projectRef);
  const thread = useThreadShell(threadRef);
  const threadDetail = useThreadDetail(threadRef);
  const capabilities = {
    dispatcher: environment?.serverConfig?.environment.capabilities.dispatcherRoutePreview === true,
    workflow: environment?.serverConfig?.environment.capabilities.workflowOs === true,
    cursorCloud: environment?.serverConfig?.environment.capabilities.cursorCloudRunner === true,
  };
  const providers = environment?.serverConfig?.providers ?? [];
  const preferredRoute = thread?.modelSelection ?? project?.defaultModelSelection ?? null;
  const boundRoute = thread?.latestRoute?.binding ?? threadDetail?.latestRoute?.binding ?? null;
  const runPreview = useAtomCommand(dispatcherEnvironment.previewRoute, {
    reportFailure: false,
    reportDefect: false,
  });
  const readCatalog = useAtomCommand(workflowEnvironment.catalog, { reportFailure: false });
  const followUpCommand = useAtomCommand(workflowEnvironment.cursorCloudFollowUp, {
    reportFailure: false,
  });
  const cancelCommand = useAtomCommand(workflowEnvironment.cursorCloudCancel, {
    reportFailure: false,
  });
  const refreshCommand = useAtomCommand(workflowEnvironment.cursorCloudRefresh, {
    reportFailure: false,
  });
  const [preview, setPreview] = useState<DispatcherPreviewState>(IDLE_PREVIEW);
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState<"grant" | "deny" | "cancel" | null>(
    null,
  );
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const governanceQuery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : serverEnvironment.actionGovernance({ environmentId: props.environmentId, input: {} }),
  );
  const respondApproval = useAtomCommand(serverEnvironment.actionGateRespondApproval, {
    reportFailure: true,
  });
  const session = useAtomValue(
    props.environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateValueAtom(props.environmentId),
  );
  const canOperate =
    session?.authenticated === true &&
    session.scopes?.includes(AuthOrchestrationOperateScope) === true;

  const previewInput = useMemo<DispatcherRoutePreviewRequest | null>(
    () =>
      capabilities.dispatcher &&
      props.environmentId &&
      props.projectId &&
      preferredRoute &&
      !boundRoute
        ? {
            environmentId: props.environmentId,
            projectId: props.projectId,
            preferredRoute: {
              instanceId: preferredRoute.instanceId,
              model: preferredRoute.model,
            },
            actionKind: "workspace-write",
          }
        : null,
    [boundRoute, capabilities.dispatcher, preferredRoute, props.environmentId, props.projectId],
  );

  useEffect(() => {
    if (boundRoute !== null) {
      setPreview(IDLE_PREVIEW);
      return;
    }
    const controller = createDispatcherPreviewController({
      request: async (request) => {
        if (!props.environmentId) throw new Error("environment required");
        const result = await runPreview({ environmentId: props.environmentId, input: request });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        return result.value;
      },
      onChange: setPreview,
    });
    controller.update(previewInput);
    return () => controller.dispose();
  }, [boundRoute, previewInput, props.environmentId, runPreview]);

  useEffect(() => {
    if (!capabilities.workflow || !props.environmentId || !props.projectId) {
      setCatalog(null);
      return;
    }
    let live = true;
    void readCatalog({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }).then((result) => {
      if (live && result._tag === "Success") setCatalog(result.value);
    });
    return () => {
      live = false;
    };
  }, [capabilities.workflow, props.environmentId, props.projectId, readCatalog]);

  const workflowRun =
    catalog?.runs.find(
      (run) =>
        run.originatingThreadId === props.threadId ||
        run.attempts.some((attempt) => attempt.destinationThreadId === props.threadId),
    ) ?? null;
  const workflowTemplate =
    workflowRun === null
      ? null
      : (catalog?.templates.find(
          (template) =>
            template.id === workflowRun.templateId &&
            template.version === workflowRun.templateVersion,
        ) ?? null);
  const cursorCloudAttempt =
    workflowRun?.attempts.findLast((attempt) => attempt.runnerBinding) ?? null;
  const cursorCloudBinding = cursorCloudAttempt?.runnerBinding ?? null;

  const pendingApproval = governanceQuery.data?.pending.find((record) =>
    props.threadId === null
      ? true
      : record.threadId === undefined || record.threadId === props.threadId,
  );
  const approval = pendingApproval === undefined ? null : presentActionApproval(pendingApproval);

  const model = presentOperationalInspector({
    selected: props.projectId !== null || props.threadId !== null,
    projectTitle: project?.title ?? null,
    taskObjective: thread?.title ?? threadDetail?.title ?? null,
    gitBranch: thread?.branch ?? null,
    sessionStatus: thread?.session?.status ?? null,
    sessionError: thread?.session?.lastError ?? null,
    capabilities,
    providers,
    preview,
    boundRoute,
    workflowRun,
    workflowTemplate,
    cursorCloudBinding,
    ...(approval !== null ? { approval } : {}),
    ...(environment?.serverConfig?.environment.capabilities.openRouterGuidance !== undefined
      ? {
          openRouterPriors: {
            freshness:
              environment.serverConfig.environment.capabilities.openRouterGuidance
                .marketPriorFreshness,
            asOf:
              environment.serverConfig.environment.capabilities.openRouterGuidance
                .marketPriorAsOf ?? null,
          },
        }
      : {}),
  });

  const toggle = () => {
    const next = !userOpen;
    setUserOpen(next);
    try {
      setLocalStorageItem(INSPECTOR_OPEN_STORAGE_KEY, next, Schema.Boolean);
    } catch {
      // Persistence is optional; the inspector still toggles in memory.
    }
  };

  const runId = workflowRun?.id;
  const environmentId = props.environmentId;
  const projectId = props.projectId;
  const cursorCloudInput =
    environmentId && projectId && runId && cursorCloudAttempt
      ? {
          environmentId,
          projectId,
          runId,
          stageId: cursorCloudAttempt.stageId,
          attempt: cursorCloudAttempt.attempt,
        }
      : null;

  const mutationHandlers =
    cursorCloudInput === null
      ? {}
      : {
          onCancel: () => {
            setBusy(true);
            void cancelCommand({
              environmentId: cursorCloudInput.environmentId,
              input: { ...cursorCloudInput, commandId: randomUUID() },
            }).finally(() => setBusy(false));
          },
          onFollowUp: () => {
            setBusy(true);
            void followUpCommand({
              environmentId: cursorCloudInput.environmentId,
              input: {
                ...cursorCloudInput,
                commandId: randomUUID(),
                prompt: followUp.slice(0, 16_000),
              },
            }).finally(() => setBusy(false));
          },
          onFollowUpChange: setFollowUp,
          onRefresh: () => {
            setBusy(true);
            void refreshCommand({
              environmentId: cursorCloudInput.environmentId,
              input: cursorCloudInput,
            }).finally(() => setBusy(false));
          },
        };

  return (
    <OperationalInspector
      binding={cursorCloudBinding}
      busy={busy}
      canOperate={canOperate}
      collapsed={collapsed}
      disconnected={environment?.connection.phase !== "connected"}
      followUp={followUp}
      model={model}
      approvalError={approvalError}
      approvalSubmitting={approvalSubmitting}
      onToggle={toggle}
      {...(approval !== null && props.environmentId !== null
        ? {
            onApprovalRespond: (decision) => {
              setApprovalSubmitting(decision);
              setApprovalError(null);
              void respondApproval({
                environmentId: props.environmentId!,
                input: {
                  approvalId: ActionApprovalId.make(approval.approvalId),
                  decision,
                },
              }).then((result) => {
                setApprovalSubmitting(null);
                if (result._tag === "Success") {
                  governanceQuery.refresh();
                  return;
                }
                setApprovalError("The server rejected that approval decision.");
              });
            },
          }
        : {})}
      {...mutationHandlers}
    />
  );
}
