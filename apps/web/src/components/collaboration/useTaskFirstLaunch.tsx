import { TaskResultHandoffReadout, readFreshHandoff } from "./TaskResultHandoff";
import { resultHandoffInput } from "@t3tools/shared/taskResultHandoff";
import { digestCanonical } from "@t3tools/shared/actionCanonical";
import { verifyJointTaskInputReview } from "@t3tools/shared/taskJointInputReview";
import { TaskReferenceFilePicker, type TaskReferenceSelection } from "./TaskReferenceFilePicker";
import {
  taskInstructionSkillModules,
  taskInstructionSkillRef,
} from "@t3tools/shared/taskInstructionSkills";
import { type TaskInstructionSkillModule } from "@t3tools/contracts";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { TaskInstructionSkillReadout } from "./TaskInstructionSkillReadout";
import { useLayoutEffect, useRef, useState, useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type CollaborationTask,
  type TaskContractReviewState,
  type OrchestrationV2AppThread,
  type TaskFirstLaunch,
  type TaskContinuationResult,
  type ModelSelection,
  type TaskFirstLaunchStatus,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { primaryServerProvidersAtom } from "../../state/server";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { randomUUID } from "../../lib/utils";
import { providerExecutable } from "./agentDirectory";
import { Button } from "../ui/button";
import {
  readFirstLaunchAttempt,
  writeFirstLaunchAttempt,
  clearRejectedFirstLaunchAttempt,
  firstLaunchStorageKey,
  continuationStorageKey,
  retireCompletedContinuationAttempt,
  type FirstLaunchAttempt,
} from "./taskFirstLaunchAttempt";
type Review = Extract<TaskContractReviewState, { status: "available" }>;
type Dispatch = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

/** Ordinary chat launch and durable, read-only reconciliation; capability review owns its own action. */
export function useTaskFirstLaunch(props: {
  environmentId: EnvironmentId;
  task: CollaborationTask;
  facts: Review | null;
  thread: OrchestrationV2AppThread | null;
  text: string;
  stale: boolean;
  onOpen: () => void;
  resultBound?: boolean;
  // Only unsent intent is gated. Original-command status recovery remains independent.
  reviewIsCurrent?: (() => boolean) | undefined;
  priorResult?: TaskContinuationResult | null;
}) {
  const readSourceReview = useAtomCommand(threadEnvironment.readTaskReview, {
    reportFailure: false,
  });
  const readSourceProjection = useAtomCommand(threadEnvironment.readProjection, {
    reportFailure: false,
  });
  const source = props.resultBound
    ? undefined
    : props.thread?.agentsTaskCreation?.review.resultHandoff;
  const readFileReview = useAtomCommand(threadEnvironment.readTaskReferenceFileReview, {
    reportFailure: false,
  });
  const [referenceFile, setReferenceFile] = useState<TaskReferenceSelection | null>(null);
  const readSkillReview = useAtomCommand(threadEnvironment.readTaskInstructionSkillReview, {
    reportFailure: false,
  });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const readStatus = useAtomCommand(
    props.resultBound
      ? threadEnvironment.readResultContinuationStatus
      : threadEnvironment.readFirstLaunchStatus,
    {
      reportFailure: false,
    },
  );
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const providers = useAtomValue(primaryServerProvidersAtom);
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  const options = useMemo(() => new Map(entries.map((e) => [e.instanceId, e.models])), [entries]);
  const key = (props.resultBound ? continuationStorageKey : firstLaunchStorageKey)(
    props.environmentId,
    props.task.threadId ?? "missing",
  );
  const [saved, setSaved] = useState(() => readFirstLaunchAttempt(key));
  const retainFile = useRef(saved.attempt !== null);
  const [skillChoices, setSkillChoices] = useState<ReadonlyMap<string, string>>(new Map());
  const skillChoice = props.resultBound ? "" : (skillChoices.get(key) ?? "");
  const skillCatalog = taskInstructionSkillModules();
  const selectedModule = skillCatalog.find((module) => module.id === skillChoice);
  const selectedSkill = selectedModule ? taskInstructionSkillRef(selectedModule) : null;
  const invalidSkill = !!skillChoice && !selectedModule;
  const [reviewBusy, setReviewBusy] = useState(false);
  const preparing = useRef(false);
  const [mode, setMode] = useState<"manual" | "auto" | null>(null);
  const [manualChoice, setManual] = useState<ModelSelection | null>(null);
  const manual = manualChoice ?? props.thread?.modelSelection ?? null;
  type LaunchReview = TaskFirstLaunch & { readonly priorResult?: TaskContinuationResult };
  type PreparedReview = {
    key: string;
    token: symbol;
    value: LaunchReview;
    module: TaskInstructionSkillModule | null;
  };
  const [reviewed, setReviewed] = useState<PreparedReview | null>(null);
  const activeReview = useRef<PreparedReview | null>(null);
  const [status, setStatus] = useState<TaskFirstLaunchStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(false);
  const latest = useRef(props);
  const context = useRef({ key, session });
  useLayoutEffect(() => {
    latest.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      pending.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (context.current.key !== key || context.current.session !== session) {
      const changedScope = context.current.key !== key;
      context.current = { key, session };
      epoch.current++;
      pending.current = false;
      setBusy(false);
      setReviewed(null);
      setReferenceFile(null);
      setStatus(null);
      setNotice(null);
      const retained = readFirstLaunchAttempt(key);
      retainFile.current = retained.attempt !== null;
      setSaved(
        retained.attempt
          ? {
              ...retained,
              attempt: {
                ...retained.attempt,
                status: retained.attempt.status === "rejected" ? "rejected" : "unknown",
              },
            }
          : retained,
      );
      if (changedScope) {
        setMode(null);
        setManual(null);
      }
    }
  }, [key, session]);
  const reviewKey = JSON.stringify([
    key,
    props.text,
    mode,
    manual,
    props.facts?.reference,
    props.facts?.contract,
    props.stale,
    props.priorResult,
    source,
    props.thread?.runtimeMode,
    props.thread?.interactionMode,
    selectedSkill,
    referenceFile,
    invalidSkill,
  ]);
  // A-B-A invalidates authority even if the same inert selection is restored.
  const reviewToken = useMemo(
    () => Symbol(`${session === null ? "disconnected" : "connected"}:${reviewKey}`),
    // Session identity intentionally retires authority even when the visible review key is unchanged.
    // eslint-disable-next-line react/preserve-manual-memoization
    [reviewKey, session],
  );
  const reviewOwner = useRef<symbol | null>(reviewToken);
  useLayoutEffect(() => {
    reviewOwner.current = reviewToken;
    activeReview.current = null;
    preparing.current = false;
    // External launch facts retire executable review without changing saved original identity.
    // eslint-disable-next-line react/set-state-in-effect
    setReviewed(null);
    setReviewBusy(false);
    return () => {
      reviewOwner.current = null;
      activeReview.current = null;
    };
  }, [reviewToken]);
  const review =
    reviewed?.token === reviewToken && reviewed.key === reviewKey ? reviewed.value : null;
  const reviewModule = review ? reviewed?.module : null;
  const autoIntent = useMemo(
    () =>
      (review?.instructionSkill || review?.referenceFile) && review.routingMode === "auto"
        ? classifyLocalTask(review.text)
        : null,
    [review],
  );
  const setReview = (
    value: LaunchReview | null,
    module: TaskInstructionSkillModule | null = null,
  ) => {
    const next = value ? { key: reviewKey, token: reviewToken, value, module } : null;
    activeReview.current = next;
    setReviewed(next);
  };
  useLayoutEffect(() => {
    const proof = review?.referenceFile ?? review?.instructionSkill;
    if (!proof) return;
    const timer = setTimeout(
      () => {
        if (reviewOwner.current === reviewToken) {
          activeReview.current = null;
          setReviewed(null);
          setNotice(
            review?.referenceFile
              ? "Reference file review expired. Review again before Start."
              : "Instruction module review expired. Review again before Start.",
          );
        }
      },
      Math.max(0, Date.parse(proof.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review?.instructionSkill, review?.referenceFile, reviewToken]);
  const current = (generation: number) =>
    mounted.current &&
    epoch.current === generation &&
    context.current.key === key &&
    context.current.session === session &&
    session !== null;
  const store = (attempt: FirstLaunchAttempt) => {
    writeFirstLaunchAttempt(key, attempt);
    setSaved({ attempt, error: null });
  };
  const reconcile = async (command: Dispatch, generation: number, open: boolean) => {
    const result = await readStatus({ environmentId: props.environmentId, input: { command } });
    if (!current(generation)) return;
    const proof: TaskFirstLaunchStatus =
      result._tag === "Success"
        ? result.value
        : { status: "unknown", reason: "Admission outcome could not be read. Do not resend." };
    setStatus(proof);
    const next: FirstLaunchAttempt = {
      command,
      status:
        proof.status === "admitted"
          ? "admitted"
          : proof.status === "rejected"
            ? "rejected"
            : "unknown",
    };
    try {
      store(next);
    } catch {
      setSaved({
        attempt: next,
        error:
          "Original identity retained in memory; recovery storage could not be updated. No resend.",
      });
    }
    if (proof.status === "admitted") {
      setNotice("Original launch admitted. Admission is not model completion or task acceptance.");
      if (open && !props.resultBound) latest.current.onOpen();
    } else setNotice(proof.reason);
  };
  const submit = async () => {
    if (
      !review ||
      props.reviewIsCurrent?.() === false ||
      activeReview.current?.value !== review ||
      reviewOwner.current !== reviewToken ||
      (review.instructionSkill && Date.parse(review.instructionSkill.expiresAt) <= Date.now()) ||
      (review.referenceFile && Date.parse(review.referenceFile.expiresAt) <= Date.now()) ||
      pending.current ||
      session === null ||
      props.stale ||
      (props.resultBound && !review.priorResult)
    )
      return;
    const existing = readFirstLaunchAttempt(key);
    if (existing.error || existing.attempt) {
      setSaved(existing);
      setNotice(
        existing.error ??
          "An original launch identity is retained. Read its status; no replacement was allocated.",
      );
      setReview(null);
      return;
    }
    const command: Dispatch = {
      type: "message.dispatch",
      commandId: review.commandId,
      threadId: review.threadId,
      messageId: review.messageId,
      text: review.text,
      attachments: review.referenceFile ? [review.referenceFile.source] : [],
      modelSelection: review.modelSelection,
      routingMode: review.routingMode,
      ...(props.resultBound && review.priorResult
        ? { taskResultContinuation: { ...review, priorResult: review.priorResult } }
        : { taskFirstLaunch: review }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    };
    try {
      store({ status: "pending", command });
      retainFile.current = true;
    } catch {
      setNotice("Recovery storage could not retain the original command. Nothing was sent.");
      return;
    }
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    setReview(null);
    setNotice(null);
    try {
      await start({
        environmentId: props.environmentId,
        input: {
          commandId: command.commandId,
          threadId: command.threadId,
          message: {
            messageId: command.messageId,
            role: "user",
            text: command.text,
            attachments: command.attachments,
          },
          modelSelection: review.modelSelection,
          routingMode: review.routingMode,
          dispatchMode: "start",
          runtimeMode: review.runtimeMode,
          interactionMode: review.interactionMode,
          ...(command.taskResultContinuation
            ? { taskResultContinuation: command.taskResultContinuation }
            : { taskFirstLaunch: review }),
        },
      });
      if (current(generation)) await reconcile(command, generation, false);
    } catch {
      if (current(generation)) {
        const next: FirstLaunchAttempt = { command, status: "unknown" };
        try {
          store(next);
        } catch {
          setSaved({ attempt: next, error: "Recovery storage unavailable; do not resend." });
        }
        setNotice(
          "Launch outcome UNKNOWN. Read original launch status; no automatic retry or replacement identity was sent.",
        );
      }
    } finally {
      if (current(generation)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const recover = async () => {
    const retained = readFirstLaunchAttempt(key);
    if (retained.error || !retained.attempt || pending.current || session === null) {
      setSaved(retained);
      return;
    }
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    try {
      await reconcile(retained.attempt.command, generation, false);
    } catch {
      if (current(generation)) setNotice("Original launch remains UNKNOWN. No resend was sent.");
    } finally {
      if (current(generation)) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const selected = manual ? providers.find((p) => p.instanceId === manual.instanceId) : undefined;
  const manualReady =
    manual !== null &&
    selected !== undefined &&
    providerExecutable(selected) &&
    selected.models.some((m) => m.slug === manual.model);
  const available =
    (!props.resultBound || (props.priorResult !== null && props.priorResult !== undefined)) &&
    props.facts !== null &&
    props.thread !== null &&
    !props.stale &&
    session !== null &&
    !saved.error &&
    !saved.attempt;
  const recovery = (
    <section aria-label="Original task launch">
      {saved.error ? <p role="alert">{saved.error}</p> : null}
      {saved.attempt ? (
        <>
          <p>
            Original command {saved.attempt.command.commandId}; message{" "}
            {saved.attempt.command.messageId}. Outcome:{" "}
            {status?.status ?? "UNKNOWN until reconciled"}. No automatic resend.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session === null}
            onClick={() => void recover()}
          >
            {props.resultBound
              ? "Read original continuation status"
              : "Read original launch status"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session === null}
            onClick={props.onOpen}
          >
            Open original conversation and results
          </Button>
          {status?.status === "admitted" ? (
            <>
              <TaskResultHandoffReadout
                source={status.resultHandoffSelection}
                delivery={status.resultHandoffDelivery}
              />
              {status.referenceFileSelection ? (
                <section aria-label="Reference file provenance">
                  <p>
                    Selected reference {status.referenceFileSelection.source.name}; content SHA256{" "}
                    {status.referenceFileSelection.contentSha256}
                  </p>
                  <p>
                    Native attachment delivery:{" "}
                    {status.referenceFileDelivery?.status ?? "Unknown / no delivery evidence"};
                    final {status.referenceFileDelivery?.attachment.id ?? "Unknown"}. Delivery is
                    not provider completion or owner acceptance.
                  </p>
                </section>
              ) : null}
              {status.referenceFileDelivery ? (
                <p>
                  Observed file {status.referenceFileDelivery.attachment.name}; content SHA256{" "}
                  {status.referenceFileDelivery.contentSha256}; source{" "}
                  {status.referenceFileDelivery.source.id}; final{" "}
                  {status.referenceFileDelivery.attachment.id}; run{" "}
                  {status.referenceFileDelivery.runId}; attempt{" "}
                  {status.referenceFileDelivery.attemptId}; message{" "}
                  {status.referenceFileDelivery.messageId}; actual model{" "}
                  {status.referenceFileDelivery.modelSelection.instanceId} /{" "}
                  {status.referenceFileDelivery.modelSelection.model}.
                </p>
              ) : null}
              <TaskInstructionSkillReadout
                selection={status.instructionSkillSelection}
                delivery={status.instructionSkillDelivery}
              />
            </>
          ) : null}
          {status?.status === "admitted" ? (
            <p>
              Run {status.runId}; attempt {status.attemptId}; model{" "}
              {status.actualModelSelection.instanceId} / {status.actualModelSelection.model}; run
              status {status.runStatus}. {status.resultPreview}
            </p>
          ) : null}
          {props.resultBound &&
          status?.status === "admitted" &&
          status.runStatus === "completed" &&
          props.priorResult?.runId === status.runId &&
          props.facts &&
          !props.stale ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || session === null}
              onClick={() => {
                try {
                  retireCompletedContinuationAttempt(key, saved.attempt!.command.commandId);
                  setSaved({ attempt: null, error: null });
                  setStatus(null);
                  setReview(null);
                  setMode(null);
                  setManual(null);
                  setNotice(
                    "Original completed continuation retained in task history. Review another request explicitly.",
                  );
                } catch {
                  setNotice("Original continuation could not be retired safely.");
                }
              }}
            >
              Review changes on latest result
            </Button>
          ) : null}
          {saved.attempt.status === "rejected" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  clearRejectedFirstLaunchAttempt(key);
                  retainFile.current = false;
                  setSaved({ attempt: null, error: null });
                  setStatus(null);
                  setReview(null);
                  setNotice(
                    "Original rejected identity retired. Prepare and review a new launch explicitly.",
                  );
                } catch {
                  setNotice("Unresolved identity cannot be replaced.");
                }
              }}
            >
              Review a new launch after rejection
            </Button>
          ) : null}
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
  const controls = (
    <section aria-label="Ordinary governed task launch">
      <TaskResultHandoffReadout source={source} complete />
      <p>
        {props.resultBound
          ? "Ordinary requested changes on the exact completed result. No contract, acceptance, configuration or capability mutation."
          : "Ordinary model turn — choose and review separately from the saved-PR operation below. Unsupported saved-PR suggestions never start this path automatically."}
      </p>
      {!props.resultBound && !source ? (
        <TaskReferenceFilePicker
          key={key}
          environmentId={props.environmentId}
          session={session}
          disabled={!available || busy || saved.attempt !== null}
          retain={retainFile}
          onChange={setReferenceFile}
        />
      ) : null}
      {referenceFile && skillChoice ? (
        <p>
          Review the reference and instruction skill together before starting. File content remains
          untrusted evidence; the skill grants no additional authority.
        </p>
      ) : null}
      {!props.resultBound && !source ? (
        <section aria-label="First-party instruction module selection">
          <label>
            Instruction-only task skill
            <Select
              value={skillChoice || "none"}
              disabled={!available || busy || reviewBusy}
              onValueChange={(value) => {
                if (!available || busy || preparing.current || reviewOwner.current !== reviewToken)
                  return;
                setSkillChoices((previous) =>
                  new Map(previous).set(key, value === "none" ? "" : (value ?? "")),
                );
                setReview(null);
              }}
            >
              <SelectTrigger aria-label="First-party task instruction skill">
                <SelectValue placeholder="No skill selected" />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="none">No skill selected</SelectItem>
                {skillCatalog.map((module) => (
                  <SelectItem key={module.id} value={module.id}>
                    {module.name} v{module.version}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <p>
            Explicit code-owned instruction text only. No tools, permissions, access or budget
            granted. Choose Manual or Auto and review the exact body before Start.
          </p>
          {invalidSkill ? <p>Selected instruction module unavailable; no fallback.</p> : null}
        </section>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!available || busy}
          onClick={() => setMode("manual")}
        >
          Choose Manual
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!available || busy || reviewBusy}
          onClick={() => setMode("auto")}
        >
          Choose Auto
        </Button>
      </div>
      {manual && mode ? (
        <ProviderModelPicker
          activeInstanceId={manual.instanceId}
          model={manual.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          routingMode={mode}
          onRoutingModeChange={(value) => {
            setMode(value);
          }}
          disabled={!available || busy}
          onInstanceModelChange={(instanceId, model) => {
            setManual((previous) =>
              previous?.instanceId === instanceId && previous.model === model
                ? previous
                : { instanceId, model },
            );
            setMode("manual");
          }}
        />
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={
          !available ||
          busy ||
          reviewBusy ||
          invalidSkill ||
          (referenceFile !== null && referenceFile.status !== "ready") ||
          !mode ||
          !manual ||
          !props.text.trim() ||
          (mode === "manual" && !manualReady)
        }
        onClick={() => {
          if (
            !available ||
            props.reviewIsCurrent?.() === false ||
            !props.facts ||
            !props.thread ||
            !mode ||
            !manual ||
            preparing.current ||
            reviewOwner.current !== reviewToken ||
            invalidSkill ||
            (referenceFile !== null && referenceFile.status !== "ready")
          )
            return;
          const value: LaunchReview = {
            commandId: CommandId.make(randomUUID()),
            messageId: MessageId.make(randomUUID()),
            threadId: props.thread.id,
            reference: props.facts.reference,
            contract: props.facts.contract,
            text: props.text,
            routingMode: mode,
            modelSelection: manual,
            runtimeMode: props.thread.runtimeMode,
            interactionMode: props.thread.interactionMode,
            ...(source ? { resultHandoff: source } : {}),
            ...(props.resultBound && props.priorResult ? { priorResult: props.priorResult } : {}),
          };
          if (source) {
            const token = reviewToken;
            preparing.current = true;
            setReviewBusy(true);
            setReview(null);
            return (async () => {
              try {
                const current = await readFreshHandoff(
                  props.environmentId,
                  source.reference.taskId,
                  readSourceReview,
                  readSourceProjection,
                );
                if (reviewOwner.current !== token) return;
                if (!current || digestCanonical(current) !== digestCanonical(source))
                  throw new Error("Source changed");
                resultHandoffInput(value.text, source);
                setReview(value);
              } catch {
                if (reviewOwner.current === token)
                  setNotice("Accepted source or combined input budget changed. Nothing started.");
              } finally {
                if (reviewOwner.current === token) {
                  preparing.current = false;
                  setReviewBusy(false);
                }
              }
            })();
          }
          if (referenceFile?.status === "ready") {
            const token = reviewToken;
            preparing.current = true;
            setReviewBusy(true);
            setReview(null);
            void (async () => {
              try {
                const result = await readFileReview({
                  environmentId: props.environmentId,
                  input: {
                    launch: value,
                    attachment: referenceFile.attachment,
                    contentSha256: referenceFile.contentSha256,
                    ...(selectedSkill ? { module: selectedSkill } : {}),
                  },
                });
                if (reviewOwner.current !== token) return;
                if (result._tag !== "Success" || result.value.status !== "available") {
                  setNotice(
                    "Reference file or task facts unavailable. Nothing started; no file was dropped.",
                  );
                  return;
                }
                const proof = result.value.review;
                if (
                  JSON.stringify(proof.source) !== JSON.stringify(referenceFile.attachment) ||
                  proof.contentSha256 !== referenceFile.contentSha256
                ) {
                  setNotice("Reviewed file differs from the selected upload. Nothing started.");
                  return;
                }
                const skill = result.value.instructionSkill;
                const module = result.value.module;
                if (selectedSkill) {
                  if (
                    !skill ||
                    !module ||
                    JSON.stringify(taskInstructionSkillRef(module)) !==
                      JSON.stringify(selectedSkill) ||
                    JSON.stringify(skill.module) !== JSON.stringify(selectedSkill)
                  ) {
                    setNotice("Joint instruction module differs or is missing. Nothing started.");
                    return;
                  }
                  const joint = { ...value, referenceFile: proof, instructionSkill: skill };
                  verifyJointTaskInputReview(joint);
                  setReview(joint, module);
                } else if (skill || module) {
                  setNotice("Unexpected companion module. Review the selected inputs again.");
                } else setReview({ ...value, referenceFile: proof });
              } catch {
                if (reviewOwner.current === token)
                  setNotice("Reference file review unavailable. Nothing started.");
              } finally {
                if (reviewOwner.current === token) {
                  preparing.current = false;
                  setReviewBusy(false);
                }
              }
            })();
            return;
          }
          if (!selectedSkill) {
            setReview(value);
            return;
          }
          const token = reviewToken;
          preparing.current = true;
          setReviewBusy(true);
          setReview(null);
          setNotice(null);
          void (async () => {
            try {
              const result = await readSkillReview({
                environmentId: props.environmentId,
                input: { launch: value, module: selectedSkill },
              });
              if (reviewOwner.current !== token) return;
              if (result._tag !== "Success" || result.value.status !== "available") {
                setNotice(
                  "Instruction module or launch facts changed; no Start is available. Review again.",
                );
                return;
              }
              if (
                JSON.stringify(taskInstructionSkillRef(result.value.module)) !==
                JSON.stringify(selectedSkill)
              ) {
                setNotice("Server module differs from the selected content. No substitution.");
                return;
              }
              setReview({ ...value, instructionSkill: result.value.review }, result.value.module);
            } catch {
              if (reviewOwner.current === token)
                setNotice("Instruction module review unavailable. Nothing was started.");
            } finally {
              if (reviewOwner.current === token) {
                preparing.current = false;
                setReviewBusy(false);
              }
            }
          })();
        }}
      >
        {props.resultBound ? "Review result continuation" : "Review ordinary task launch"}
      </Button>
      {review ? (
        <div aria-label="Reviewed ordinary task launch">
          <p>Exact instructions: {review.text}</p>
          {review.referenceFile && review.instructionSkill ? (
            <p>
              Joint review {review.referenceFile.reviewId}; binding SHA256{" "}
              {review.referenceFile.bindingSha256}. Both inputs must remain unchanged; neither
              expands the task contract or permissions.
            </p>
          ) : null}
          {review.referenceFile ? (
            <section aria-label="Reviewed task reference file">
              <p>
                {review.referenceFile.source.name} · {review.referenceFile.source.mimeType} ·{" "}
                {review.referenceFile.source.sizeBytes} bytes
              </p>
              <p>
                Content SHA256 {review.referenceFile.contentSha256}; source{" "}
                {review.referenceFile.source.id}; final {review.referenceFile.attachment.id}; review{" "}
                {review.referenceFile.reviewId}; expires {review.referenceFile.expiresAt}. Upload
                and review are not execution.
              </p>
            </section>
          ) : null}
          {reviewModule && review.instructionSkill ? (
            <section aria-label="Exact reviewed instruction module">
              <p>
                {reviewModule.name} · {reviewModule.id} v{reviewModule.version}
              </p>
              <p>
                Body SHA256 {review.instructionSkill.module.contentSha256}; module SHA256{" "}
                {review.instructionSkill.module.moduleSha256}
              </p>
              <p>Input: {reviewModule.inputExpectation}</p>
              <p>Output: {reviewModule.outputExpectation}</p>
              <pre className="whitespace-pre-wrap break-all">{reviewModule.body}</pre>
              <p>
                Instruction-only; grantsAccess false; tools none; permissions none. Review expires{" "}
                {review.instructionSkill.expiresAt}. Review {review.instructionSkill.reviewId}.
                Command {review.commandId}; message {review.messageId}. Adapter delivery will be
                recorded separately; this is no completion or acceptance claim.
              </p>
            </section>
          ) : null}
          <p>
            Task {review.reference.taskId}; project {review.reference.projectId}; environment{" "}
            {review.reference.environmentId}; contract revision {review.contract.revision}. Goal:{" "}
            {review.contract.goal}. Redirect: {review.contract.redirect}. Acceptance:{" "}
            {review.contract.acceptance}.
          </p>
          <p>
            Mode: {review.routingMode}.{" "}
            {review.routingMode === "manual"
              ? `Explicit provider/model: ${review.modelSelection.instanceId} / ${review.modelSelection.model}`
              : "Auto recalculates its authoritative route at dispatch; any preview is advisory, not a locked target or optimality guarantee."}
          </p>
          {autoIntent ? (
            <p>
              Advisory local Auto intent: {autoIntent.category} ({autoIntent.classifierVersion}).
              Dispatch reevaluates the current policy and eligible targets; this classification
              grants no capability or locked model.
            </p>
          ) : null}
          <p>
            Provider start cap {review.contract.brake.maxProviderStarts}; token cap{" "}
            {review.contract.brake.maxTokens ?? "not declared"}; cost cap{" "}
            {review.contract.brake.maxCostUsd ?? "not declared"}; deadline{" "}
            {review.contract.brake.deadlineAt ?? "not declared"}; stop conditions{" "}
            {review.contract.brake.stopConditions}. No contract acceptance or capability guarantee.
          </p>
          <Button
            size="sm"
            disabled={!available || busy || (review.routingMode === "manual" && !manualReady)}
            onClick={() => submit()}
          >
            {props.resultBound
              ? "Start reviewed result continuation"
              : "Start reviewed ordinary task"}
          </Button>
        </div>
      ) : null}
    </section>
  );
  return {
    controls,
    recovery,
    busy,
    reviewed: review !== null,
    hasOriginal: saved.attempt !== null || saved.error !== null,
  };
}
