import { planTaskCapabilities } from "@t3tools/shared/taskCapabilityPlan";
import { TaskCapabilityReadout } from "./TaskCapabilityReadout";
import { TaskFirstInstructions } from "./TaskFirstInstructions";
import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  TaskContractFields,
  AgentsTaskCreationReview,
  ModelSelection,
  type EnvironmentId,
  type ServerProvider,
  type CollaborationSnapshot,
  type CollaborationTask,
  OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { usePreparedConnection } from "../../state/session";
import * as Schema from "effect/Schema";
import { useCallback, useLayoutEffect, useRef, useState, useMemo } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newThreadId } from "../../lib/utils";
import { providerExecutable } from "./agentDirectory";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  readAgentsCreationAttempt,
  writeAgentsCreationAttempt,
  type AgentsCreationAttempt,
} from "./agentsTaskCreationAttempt";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

type Create = Extract<OrchestrationV2Command, { type: "thread.create" }>;
const sameCommand = Schema.toEquivalence(OrchestrationV2Command.members[0]);
const sameContract = Schema.toEquivalence(TaskContractFields);
const sameReview = Schema.toEquivalence(AgentsTaskCreationReview);
const sameSelection = Schema.toEquivalence(ModelSelection);
const decodeContract = Schema.decodeUnknownOption(TaskContractFields);
const blank = {
  title: "",
  goal: "",
  redirect: "",
  acceptance: "",
  maxProviderStarts: "",
  stopConditions: "",
  maxTokens: "",
  maxCostUsd: "",
  deadlineAt: "",
};
function parseDraft(draft: typeof blank) {
  if (
    ["maxProviderStarts", "maxTokens", "maxCostUsd"].some((field) => {
      const value = draft[field as keyof typeof blank].trim();
      return (
        value !== "" &&
        (!Number.isFinite(Number(value)) ||
          (field !== "maxCostUsd" && !Number.isSafeInteger(Number(value))))
      );
    })
  )
    return null;
  const deadlineAt = draft.deadlineAt.trim();
  const contract = decodeContract({
    goal: draft.goal.trim(),
    redirect: draft.redirect.trim(),
    acceptance: draft.acceptance.trim(),
    brake: {
      maxProviderStarts: Number(draft.maxProviderStarts),
      stopConditions: draft.stopConditions.trim(),
      ...(draft.maxTokens.trim() ? { maxTokens: Number(draft.maxTokens) } : {}),
      ...(draft.maxCostUsd.trim() ? { maxCostUsd: Number(draft.maxCostUsd) } : {}),
      ...(deadlineAt ? { deadlineAt } : {}),
    },
  });
  return draft.title.trim() &&
    contract._tag === "Some" &&
    (!deadlineAt || (deadlineAt.endsWith("Z") && Number.isFinite(Date.parse(deadlineAt))))
    ? { title: draft.title.trim(), contract: contract.value }
    : null;
}

export function AgentsTaskCreator(props: {
  readonly environmentId: EnvironmentId | null;
  readonly project:
    | { readonly id: string; readonly title: string; readonly workspaceRoot?: string }
    | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly request: { readonly providerId: string; readonly token: string } | null;
  readonly onLock: (owner: string) => void;
  readonly onRelease: (owner: string) => void;
  readonly onOpen: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly refresh: () => Promise<CollaborationSnapshot | undefined>;
}) {
  const sessionContext = Option.getOrNull(usePreparedConnection(props.environmentId));
  const currentSessionContext = useRef(sessionContext);
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const readStatus = useAtomCommand(threadEnvironment.readCreationStatus, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const [attempt, setAttempt] = useState<AgentsCreationAttempt | null>(() => {
    const saved = readAgentsCreationAttempt().attempt;
    return saved ? { ...saved, status: "uncertain" } : null;
  });
  const confirmedIdentity = useRef<CommandId | null>(null);
  const [createdTask, setCreatedTask] = useState<CollaborationTask | null>(null);
  const attemptRef = useRef(attempt);
  const [editing, setEditing] = useState<{
    providerId: string;
    driver: ServerProvider["driver"];
    token: string;
    context: string;
  } | null>(null);
  const editingOwner = useRef<string | null>(null);
  const draftThreadIdentity = useRef<ThreadId | null>(null);
  const [draft, setDraft] = useState(blank);
  const [modelChoice, setModelChoice] = useState<{ token: string; model: string } | null>(null);
  const modelChoiceRef = useRef(modelChoice);
  const [review, setReview] = useState<Create | null>(null);
  const reviewRef = useRef<Create | null>(null);
  const closeReview = useCallback(() => {
    reviewRef.current = null;
    setReview(null);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const mutationOwner = useRef<CommandId | null>(null);
  const recoveryOwner = useRef<object | null>(null);
  const mounted = useRef(true);
  const latest = useRef(props);
  const epoch = useRef(0);
  const selectedProviderId =
    editing?.providerId ?? props.request?.providerId ?? attempt?.command.modelSelection.instanceId;
  const selectedProvider = props.providers.find(
    (provider) => provider.instanceId === selectedProviderId,
  );
  const chosenModel = editing && modelChoice?.token === editing.token ? modelChoice.model : null;
  const modelAvailable =
    chosenModel !== null && selectedProvider?.models.some((m) => m.slug === chosenModel) === true;
  const instanceEntries = useMemo(
    () => deriveProviderInstanceEntries(selectedProvider ? [selectedProvider] : []),
    [selectedProvider],
  );
  const modelOptions = useMemo(
    () => new Map(selectedProvider ? [[selectedProvider.instanceId, selectedProvider.models]] : []),
    [selectedProvider],
  );
  const draftContext = JSON.stringify([
    props.environmentId,
    props.project?.id,
    selectedProviderId,
    selectedProvider?.driver ?? editing?.driver,
  ]);
  const reviewContext = JSON.stringify([
    draftContext,
    selectedProvider && providerExecutable(selectedProvider),
    selectedProvider?.models.map((model) => [model.slug, model.isDefault]),
    props.project?.workspaceRoot,
    selectedProvider?.skills,
    selectedProvider?.workspaceSnapshots,
    selectedProvider?.auth,
  ]);
  // Recovery keeps its original strict epoch. Only unsent text and confirmation
  // distinguish selected-provider changes from unrelated catalog churn.
  const context = `${props.environmentId}:${props.project?.id}:${props.providers.map((p) => `${p.instanceId}:${p.driver}:${providerExecutable(p)}:${p.models.map((m) => `${m.slug}:${m.isDefault}`).join(",")}`).join(";")}`;
  const currentDraftContext = useRef(draftContext);
  const currentReviewContext = useRef(reviewContext);
  const currentContext = useRef(context);
  useLayoutEffect(() => {
    latest.current = props;
    attemptRef.current = attempt;
  }, [props, attempt]);
  useLayoutEffect(() => {
    mounted.current = true;
    const saved = readAgentsCreationAttempt();
    if (saved.attempt) {
      latest.current.onLock(saved.attempt.command.commandId);
      setNotice(
        "A task creation outcome is uncertain. Recover the original task identity before creating another task. No retry will be sent.",
      );
    }
    return () => {
      mounted.current = false;
      epoch.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    if (currentContext.current !== context || currentSessionContext.current !== sessionContext) {
      const retainDraft =
        currentDraftContext.current === draftContext &&
        currentSessionContext.current === sessionContext;
      currentSessionContext.current = sessionContext;
      currentContext.current = context;
      epoch.current += 1;
      recoveryOwner.current = null;
      confirmedIdentity.current = null;
      if (attemptRef.current) {
        const unresolved: AgentsCreationAttempt = { ...attemptRef.current, status: "uncertain" };
        attemptRef.current = unresolved;
        setAttempt(unresolved);
        latest.current.onLock(unresolved.command.commandId);
      }
      setRecovering(false);
      if (retainDraft && editingOwner.current) {
        setEditing((previous) => (previous ? { ...previous, context: reviewContext } : null));
      } else {
        if (editingOwner.current) latest.current.onRelease(editingOwner.current);
        editingOwner.current = null;
        setEditing(null);
        setDraft(blank);
        modelChoiceRef.current = null;
        setModelChoice(null);
        draftThreadIdentity.current = null;
      }
      if (!retainDraft) closeReview();
    }
    currentDraftContext.current = draftContext;
  }, [
    context,
    draftContext,
    reviewContext,
    sessionContext,
    closeReview,
    currentContext,
    currentDraftContext,
    currentSessionContext,
    editingOwner,
  ]);
  useLayoutEffect(() => {
    if (currentReviewContext.current !== reviewContext) {
      currentReviewContext.current = reviewContext;
      closeReview();
      setEditing((previous) =>
        previous && editingOwner.current === previous.token
          ? { ...previous, context: reviewContext }
          : previous,
      );
    }
  }, [reviewContext, closeReview, currentReviewContext, editingOwner]);
  const requestToken = props.request?.token;
  useLayoutEffect(() => {
    const currentProps = latest.current;
    if (!currentProps.request || currentProps.request.token !== requestToken) return;
    const stored = readAgentsCreationAttempt();
    if (
      stored.error ||
      (stored.attempt &&
        ((stored.attempt.status !== "confirmed" && stored.attempt.status !== "rejected") ||
          confirmedIdentity.current !== stored.attempt.command.commandId ||
          !attemptRef.current ||
          !sameCommand(stored.attempt.command, attemptRef.current.command)))
    ) {
      setNotice(stored.error ?? "Recover the original task creation before creating another task.");
      if (stored.attempt) {
        const unresolved: AgentsCreationAttempt = { ...stored.attempt, status: "uncertain" };
        attemptRef.current = unresolved;
        setAttempt(unresolved);
        currentProps.onLock(stored.attempt.command.commandId);
      } else currentProps.onRelease(currentProps.request.token);
      return;
    }
    const provider = currentProps.providers.find(
      (p) => p.instanceId === currentProps.request!.providerId,
    );
    if (
      !currentProps.environmentId ||
      !currentProps.project ||
      !provider ||
      !providerExecutable(provider)
    ) {
      currentProps.onRelease(currentProps.request.token);
      return;
    }
    epoch.current += 1;
    mutationOwner.current = null;
    recoveryOwner.current = null;
    setAttempt(null);
    attemptRef.current = null;
    setDraft(blank);
    modelChoiceRef.current = null;
    setModelChoice(null);
    closeReview();
    setNotice(null);
    setPending(false);
    setRecovering(false);
    editingOwner.current = currentProps.request.token;
    draftThreadIdentity.current = newThreadId();
    setEditing({
      providerId: provider.instanceId,
      driver: provider.driver,
      token: currentProps.request.token,
      context: currentReviewContext.current,
    });
  }, [requestToken, closeReview, currentReviewContext, editingOwner]);
  const matchesContext = (command: Create) =>
    latest.current.environmentId === command.taskCreationReview?.environmentId &&
    latest.current.project?.id === command.projectId;
  const current = (command: Create, generation: number) =>
    mounted.current &&
    epoch.current === generation &&
    attemptRef.current?.command.commandId === command.commandId &&
    matchesContext(command);
  const confirmPersisted = async (command: Create, generation: number) => {
    const [snapshot, projection] = await Promise.all([
      latest.current.refresh(),
      readProjection({
        environmentId: command.taskCreationReview!.environmentId,
        input: { threadId: command.threadId },
      }),
    ]);
    if (!current(command, generation)) return false;
    const task = snapshot?.tasks.find(
      (t) =>
        t.threadId === command.threadId &&
        t.projectId === command.projectId &&
        t.assigneeAgentId === command.modelSelection.instanceId,
    );
    const thread = projection._tag === "Success" ? projection.value.thread : undefined;
    const proof = thread?.agentsTaskCreation;
    if (
      !task ||
      task.contractReadout?.status !== "available" ||
      !task.review ||
      task.review.reference.environmentId !== command.taskCreationReview!.environmentId ||
      !thread ||
      !proof ||
      proof.commandId !== command.commandId ||
      proof.actorId !== task.ownerAgentId ||
      !sameReview(proof.review, command.taskCreationReview!) ||
      proof.title !== command.title ||
      !sameContract(proof.taskContract, command.taskContract!) ||
      thread.id !== command.threadId ||
      thread.projectId !== command.projectId ||
      thread.providerInstanceId !== command.modelSelection.instanceId ||
      !sameSelection(thread.modelSelection, command.modelSelection) ||
      thread.lineage.rootThreadId !== command.threadId ||
      thread.lineage.parentThreadId !== null ||
      thread.lineage.relationshipToParent !== null ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    )
      return false;
    const confirmed: AgentsCreationAttempt = { command, status: "confirmed" };
    setCreatedTask(task);
    writeAgentsCreationAttempt(confirmed);
    attemptRef.current = confirmed;
    confirmedIdentity.current = command.commandId;
    setAttempt(confirmed);
    if (mutationOwner.current === command.commandId) {
      mutationOwner.current = null;
      setPending(false);
    }
    setNotice(
      `Task ${command.title} is durably recorded. Creation sent no message and started no provider work. Open its exact conversation.`,
    );
    latest.current.onRelease(command.commandId);
    return true;
  };
  const uncertain = (command: Create, generation: number) => {
    if (
      !current(command, generation) ||
      attemptRef.current?.status === "confirmed" ||
      attemptRef.current?.status === "rejected"
    )
      return;
    const next: AgentsCreationAttempt = { command, status: "uncertain" };
    try {
      writeAgentsCreationAttempt(next);
    } catch {
      /* Original pending identity remains retained. */
    }
    attemptRef.current = next;
    setAttempt(next);
    setNotice(
      "Task creation outcome is uncertain or rejected. Recover the original identity using fresh task facts; no mutation retry or second identity was sent.",
    );
  };
  const submit = async () => {
    const command = review;
    if (
      !command ||
      reviewRef.current !== command ||
      mutationOwner.current ||
      !editing ||
      editingOwner.current !== editing.token ||
      editing.context !== currentReviewContext.current ||
      !matchesContext(command)
    )
      return;
    const provider = latest.current.providers.find(
      (p) => p.instanceId === command.modelSelection.instanceId,
    );
    if (
      !provider ||
      !providerExecutable(provider) ||
      !provider.models.some((m) => m.slug === command.modelSelection.model)
    )
      return;
    const next: AgentsCreationAttempt = { command, status: "pending" };
    try {
      writeAgentsCreationAttempt(next);
    } catch {
      setNotice(
        "Creation recovery storage could not retain this identity. No task was sent. Cancel and restore session storage before trying again.",
      );
      return;
    }
    attemptRef.current = next;
    setAttempt(next);
    closeReview();
    editingOwner.current = null;
    setEditing(null);
    mutationOwner.current = command.commandId;
    setPending(true);
    latest.current.onLock(command.commandId);
    const generation = epoch.current;
    try {
      const result = await create({
        environmentId: command.taskCreationReview!.environmentId,
        input: command,
      });
      if (
        !current(command, generation) ||
        attemptRef.current?.status === "confirmed" ||
        attemptRef.current?.status === "rejected"
      )
        return;
      if (result._tag !== "Success" || !(await confirmPersisted(command, generation)))
        uncertain(command, generation);
    } catch {
      uncertain(command, generation);
    } finally {
      if (mutationOwner.current === command.commandId) {
        mutationOwner.current = null;
        if (current(command, generation)) setPending(false);
      }
    }
  };
  const recover = async () => {
    const saved = attemptRef.current;
    if (!saved || recoveryOwner.current || !matchesContext(saved.command)) return;
    const owner = {};
    recoveryOwner.current = owner;
    setRecovering(true);
    const generation = epoch.current;
    try {
      const result = await readStatus({
        environmentId: saved.command.taskCreationReview!.environmentId,
        input: { command: saved.command },
      });
      if (!current(saved.command, generation)) return;
      if (result._tag === "Success" && result.value.status === "rejected") {
        const rejected: AgentsCreationAttempt = { command: saved.command, status: "rejected" };
        writeAgentsCreationAttempt(rejected);
        attemptRef.current = rejected;
        setAttempt(rejected);
        confirmedIdentity.current = saved.command.commandId;
        mutationOwner.current = null;
        setPending(false);
        epoch.current += 1;
        setNotice(
          "This reviewed creation attempt was rejected. You may separately choose New task, review a new draft and confirm it. No retry was sent; another task may already use the original thread.",
        );
        latest.current.onRelease(saved.command.commandId);
      } else if (
        result._tag !== "Success" ||
        result.value.status !== "committed" ||
        !(await confirmPersisted(saved.command, generation))
      ) {
        uncertain(saved.command, generation);
      }
    } catch {
      uncertain(saved.command, generation);
    } finally {
      if (recoveryOwner.current === owner) {
        recoveryOwner.current = null;
        if (mounted.current) setRecovering(false);
      }
    }
  };
  const preview = () => {
    if (reviewRef.current !== null) return;
    const proposed = parseDraft(draft);
    const provider = props.providers.find((p) => p.instanceId === editing?.providerId);
    const model = provider?.models.find((m) => m.slug === chosenModel);
    if (
      !editing ||
      editingOwner.current !== editing.token ||
      editing.context !== currentReviewContext.current ||
      modelChoiceRef.current !== modelChoice ||
      modelChoice?.token !== editing.token ||
      !proposed ||
      !props.environmentId ||
      !props.project ||
      !provider ||
      !providerExecutable(provider) ||
      !model
    )
      return;
    const modelSelection = {
      instanceId: ProviderInstanceId.make(provider.instanceId),
      model: model.slug,
    };
    const command: Create = {
      type: "thread.create",
      commandId: CommandId.make(editing.token),
      threadId: draftThreadIdentity.current!,
      projectId: ProjectId.make(props.project.id),
      title: proposed.title,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      taskGovernance: "required",
      taskContract: proposed.contract,
      taskCreationReview: {
        environmentId: props.environmentId,
        projectId: ProjectId.make(props.project.id),
        modelSelection,
        capabilityPlan: planTaskCapabilities({
          environmentId: props.environmentId,
          projectId: props.project.id,
          workspace: props.project.workspaceRoot ?? null,
          modelSelection,
          contract: proposed.contract,
          provider,
        }),
      },
    };
    reviewRef.current = command;
    setReview(command);
  };
  const cancel = () => {
    if (!editing || editingOwner.current !== editing.token) return;
    const token = editing.token;
    editingOwner.current = null;
    setEditing(null);
    closeReview();
    epoch.current += 1;
    const retained = readAgentsCreationAttempt().attempt;
    if (
      (retained?.status === "confirmed" || retained?.status === "rejected") &&
      confirmedIdentity.current === retained.command.commandId
    ) {
      attemptRef.current = retained;
      setAttempt(retained);
    }
    props.onRelease(token);
  };
  const closeCurrentReview = () => {
    if (reviewRef.current === review) closeReview();
  };
  const displaysAttempt =
    attempt !== null &&
    props.environmentId === attempt.command.taskCreationReview?.environmentId &&
    props.project?.id === attempt.command.projectId;
  return (
    <section aria-label="Governed task creation">
      {notice ? <p role={attempt?.status === "confirmed" ? "status" : "alert"}>{notice}</p> : null}
      {attempt && attempt.status !== "confirmed" && attempt.status !== "rejected" ? (
        <>
          <p>
            Original task: {attempt.command.title}. Environment:{" "}
            {attempt.command.taskCreationReview?.environmentId}. Project:{" "}
            {attempt.command.projectId}. Identity: {attempt.command.threadId}.
          </p>
          <Button
            type="button"
            disabled={recovering || !displaysAttempt}
            onClick={() => void recover()}
          >
            Recover task creation
          </Button>
          {!displaysAttempt ? (
            <p>
              Return to the original environment and project to reconcile this request. No new task
              will be allocated.
            </p>
          ) : null}
        </>
      ) : null}
      {attempt?.status === "confirmed" && displaysAttempt ? (
        <>
          {createdTask && createdTask.threadId === attempt.command.threadId ? (
            <TaskFirstInstructions
              task={createdTask}
              environmentId={attempt.command.taskCreationReview!.environmentId}
              stale={false}
              readVersion={createdTask.review?.reference.threadSequence ?? 0}
              prepareLabel="Prepare created task for review/start"
              onOpen={() =>
                props.onOpen(
                  attempt.command.taskCreationReview!.environmentId,
                  attempt.command.threadId,
                )
              }
            />
          ) : null}
          <Button
            type="button"
            onClick={() => {
              if (matchesContext(attempt.command))
                props.onOpen(
                  attempt.command.taskCreationReview!.environmentId,
                  attempt.command.threadId,
                );
            }}
          >
            Open created conversation
          </Button>
        </>
      ) : null}
      {pending ? <p role="status">Task creation response pending…</p> : null}
      {editing ? (
        <div className="space-y-3">
          <h3>New governed task</h3>
          <p>
            Creation uses approval-required permissions. No message or provider work is started.
            Optional omitted bounds do not mean unlimited budget; reported cost caps are not
            provider billing hard limits.
          </p>
          <p>
            Task provider: {selectedProviderId}. Chosen model: {chosenModel ?? "Choose explicitly"}
            {chosenModel && !modelAvailable ? " (Unavailable)" : ""}.
          </p>
          <ProviderModelPicker
            activeInstanceId={ProviderInstanceId.make(editing.providerId)}
            model={chosenModel ?? ""}
            {...(chosenModel === null ? { triggerLabel: "Choose exact task model" } : {})}
            triggerAriaLabel="Choose exact task model"
            lockedProvider={editing.driver}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptions}
            disabled={review !== null || !selectedProvider || !providerExecutable(selectedProvider)}
            onInstanceModelChange={(instanceId, model) => {
              if (
                editingOwner.current !== editing.token ||
                editing.context !== currentReviewContext.current ||
                reviewRef.current ||
                instanceId !== editing.providerId ||
                !selectedProvider?.models.some((m) => m.slug === model)
              )
                return;
              const choice = { token: editing.token, model };
              modelChoiceRef.current = choice;
              setModelChoice(choice);
              closeReview();
            }}
          />
          {Object.keys(blank).map((key) => {
            const field = key as keyof typeof blank;
            const label = {
              title: "Task title",
              goal: "Goal",
              redirect: "Redirect",
              acceptance: "Acceptance",
              maxProviderStarts: "Provider start limit",
              stopConditions: "Stop conditions",
              maxTokens: "Optional token cap",
              maxCostUsd: "Optional reported cost cap (USD)",
              deadlineAt: "Optional UTC deadline",
            }[field];
            return (
              <label key={field} className="block space-y-1">
                {label}
                {["goal", "redirect", "acceptance", "stopConditions"].includes(field) ? (
                  <Textarea
                    aria-label={label}
                    value={draft[field]}
                    onChange={(e) => {
                      if (editingOwner.current === editing.token && !reviewRef.current)
                        setDraft({ ...draft, [field]: e.target.value });
                    }}
                  />
                ) : (
                  <Input
                    aria-label={label}
                    value={draft[field]}
                    onChange={(e) => {
                      if (editingOwner.current === editing.token && !reviewRef.current)
                        setDraft({ ...draft, [field]: e.target.value });
                    }}
                  />
                )}
              </label>
            );
          })}
          <Button
            type="button"
            disabled={
              !parseDraft(draft) ||
              review !== null ||
              !modelAvailable ||
              !selectedProvider ||
              !providerExecutable(selectedProvider)
            }
            onClick={preview}
          >
            Review new task
          </Button>
          <Button type="button" variant="outline" onClick={cancel}>
            Cancel new task
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) closeCurrentReview();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Create governed task?</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              {review ? (
                <>
                  <p>
                    Environment: {review.taskCreationReview?.environmentId}. Project:{" "}
                    {props.project?.title} ({review.projectId}). Provider:{" "}
                    {review.modelSelection.instanceId}. Configured model:{" "}
                    {review.modelSelection.model}. This is not a promise of the eventual Auto route.
                  </p>
                  <p>
                    Title: {review.title}. Goal: {review.taskContract?.goal}. Redirect:{" "}
                    {review.taskContract?.redirect}. Acceptance: {review.taskContract?.acceptance}.
                  </p>
                  <dl>
                    <dt>Provider start limit</dt>
                    <dd>{review.taskContract?.brake.maxProviderStarts}</dd>
                    <dt>Stop conditions</dt>
                    <dd>{review.taskContract?.brake.stopConditions}</dd>
                    <dt>Token cap</dt>
                    <dd>{review.taskContract?.brake.maxTokens ?? "Not selected"}</dd>
                    <dt>Reported cost cap (USD)</dt>
                    <dd>{review.taskContract?.brake.maxCostUsd ?? "Not selected"}</dd>
                    <dt>UTC deadline</dt>
                    <dd>{review.taskContract?.brake.deadlineAt ?? "Not selected"}</dd>
                  </dl>
                  <TaskCapabilityReadout plan={review.taskCreationReview?.capabilityPlan} />
                  <p>Permissions: approval-required/default.</p>
                  <p>
                    Create one distinct owned root with contract revision 1. Creation sends no
                    message, starts no provider, grants no execution and does not record acceptance.
                  </p>
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={closeCurrentReview}>
              Back to task draft
            </Button>
            <Button type="button" onClick={() => void submit()}>
              Create task
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
