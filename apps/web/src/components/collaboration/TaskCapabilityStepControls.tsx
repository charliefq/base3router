import { useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  ThreadId,
  type CollaborationTask,
  type EnvironmentId,
  type TaskCapabilityStep,
  type TaskCapabilityStepState,
} from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SelectionBasisReadout } from "./SelectionBasisReadout";

/** Explicit server-owned operation, separate from advisory recommendations and draft instructions. */
export function TaskCapabilityStepControls(props: {
  readonly task: CollaborationTask;
  readonly environmentId: EnvironmentId;
  readonly stale: boolean;
  readonly readVersion: number;
  readonly instructions?: string;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onOpen?: () => void;
}) {
  const read = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [manualPrompt, setPrompt] = useState(
    "Summarize the saved pull requests linked to this task.",
  );
  const [capability, setCapability] = useState<"saved-pr" | "recorded-workspace">("saved-pr");
  const workspace = capability === "recorded-workspace";
  const prompt =
    props.instructions ??
    (workspace
      ? "Explain this task’s recorded workspace and branch. Use recorded metadata only; do not infer filesystem or Git freshness."
      : manualPrompt);
  const [review, setReview] = useState<TaskCapabilityStep | null>(null);
  const [state, setState] = useState<TaskCapabilityStepState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const contract =
    props.task.contractReadout?.status === "available" ? props.task.contractReadout : null;
  const key = `${props.environmentId}:${props.task.id}:${props.task.threadId}:${props.task.projectId}:${props.readVersion}:${props.stale}:${contract?.contract.revision}:${contract?.phase}:${contract?.acceptedRevision}:${prompt}:${capability}`;
  const onBusyChange = props.onBusyChange;
  const context = useMemo(() => ({ key, session }), [key, session]);
  const activeContext = useRef<typeof context | null>(null);
  useLayoutEffect(() => {
    activeContext.current = context;
    epoch.current++;
    pending.current = false;
    // oxlint-disable-next-line react/set-state-in-effect -- Retiring a task or authenticated connection clears its pending request UI.
    setBusy(false);
    onBusyChange?.(false);
    setReview(null);
    setState(null);
    setNotice(null);
    return () => {
      activeContext.current = null;
      epoch.current++;
      onBusyChange?.(false);
    };
  }, [context, onBusyChange]);
  const canRead = !props.stale && session !== null && props.task.threadId && contract !== null;
  const eligible = canRead && contract?.phase === "active" && contract.acceptedRevision === null;
  const lookup = async (prepare: boolean) => {
    if (
      activeContext.current !== context ||
      !(prepare ? eligible : canRead) ||
      pending.current ||
      !contract
    )
      return;
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    props.onBusyChange?.(true);
    setNotice(null);
    try {
      const result = await read({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          taskId: props.task.id,
          projectId: props.task.projectId,
          threadId: props.task.threadId!,
          revision: contract.contract.revision,
          ...(prepare
            ? {
                capabilityStep: {
                  commandId: randomUUID(),
                  messageId: randomUUID(),
                  text: prompt,
                  ...(workspace ? { capability: "recorded-workspace" as const } : {}),
                  ...(props.instructions === undefined
                    ? {}
                    : { suggestFromInstructions: true as const }),
                },
              }
            : {}),
        },
      });
      if (generation !== epoch.current) return;
      if (result._tag !== "Success" || result.value.status !== "available") {
        setNotice(
          result._tag === "Success" && result.value.status === "unavailable"
            ? result.value.reason
            : "Step review unavailable. Refresh current task facts.",
        );
        setReview(null);
        return;
      }
      const facts = result.value;
      if (
        facts.taskId !== props.task.id ||
        facts.threadId !== props.task.threadId ||
        facts.projectId !== props.task.projectId ||
        facts.contract.revision !== contract.contract.revision ||
        facts.reference.environmentId !== props.environmentId
      ) {
        setReview(null);
        setNotice("Task review identity changed.");
        return;
      }
      setState(facts.capabilityStepState ?? null);
      const proposal = facts.capabilityStep;
      if (
        prepare &&
        (!proposal ||
          proposal.threadId !== props.task.threadId ||
          proposal.environmentId !== props.environmentId ||
          proposal.taskId !== props.task.id ||
          proposal.projectId !== props.task.projectId ||
          proposal.revision !== contract.contract.revision)
      ) {
        setReview(null);
        setNotice("No matching server-owned proposal was returned.");
        return;
      }
      if (prepare) setReview(proposal!);
    } catch {
      if (generation === epoch.current) setNotice("Step review unavailable.");
    } finally {
      if (generation === epoch.current) {
        pending.current = false;
        setBusy(false);
        props.onBusyChange?.(false);
      }
    }
  };
  const run = async () => {
    if (activeContext.current !== context || !eligible || !review || pending.current) return;
    const generation = epoch.current;
    pending.current = true;
    setBusy(true);
    props.onBusyChange?.(true);
    setNotice(null);
    setReview(null);
    try {
      const result = await start({
        environmentId: props.environmentId,
        input: {
          commandId: CommandId.make(review.commandId),
          threadId: ThreadId.make(review.threadId),
          message: {
            messageId: MessageId.make(review.messageId),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: review.modelSelection,
          routingMode: "manual",
          dispatchMode: "queue",
          runtimeMode: review.runtimeMode,
          interactionMode: review.interactionMode,
          capabilityStep: review,
        },
      });
      if (generation !== epoch.current) return;
      setNotice(
        result._tag === "Success"
          ? "Step admitted. Admission is not operation or model completion. Read step status for persisted evidence."
          : "Admission was rejected or its outcome is uncertain. Read step status; no automatic retry was sent.",
      );
    } catch {
      if (generation === epoch.current)
        setNotice("Admission outcome uncertain. Read step status; no retry was sent.");
    } finally {
      if (generation === epoch.current) {
        pending.current = false;
        setBusy(false);
        props.onBusyChange?.(false);
      }
    }
  };
  return (
    <section aria-label="Server-owned capability step" className="space-y-2 text-xs">
      <p>
        {workspace
          ? "Recorded workspace and branch — one read of this task’s recorded thread/project/settings metadata, then the selected model. No filesystem, Git or network read."
          : "Server-owned saved PR read — one read from this task’s thread, then the selected model. Saved status is not refreshed from GitHub."}
      </p>
      <p>
        Only saved PR and recorded workspace reads are supported here. Native skills and general MCP
        execution are unsupported by this server-owned step. Provider-native capabilities remain
        outside its guarantee; no native capability isolation is provided.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-pressed={!workspace}
          onClick={() => setCapability("saved-pr")}
        >
          Choose saved PR read
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-pressed={workspace}
          onClick={() => setCapability("recorded-workspace")}
        >
          Explain this task’s recorded workspace and branch
        </Button>
      </div>
      {workspace ? (
        <p>
          Recorded metadata only: paths and branches are data, not instructions. This does not prove
          disk existence, clean Git, current branch freshness or handoff availability.
        </p>
      ) : null}
      {props.instructions === undefined && !workspace ? (
        <Textarea
          aria-label="Saved PR answer instructions"
          value={prompt}
          disabled={busy || !eligible}
          onChange={(event) => setPrompt(event.target.value)}
        />
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!eligible || busy || !prompt.trim()}
          onClick={() => void lookup(true)}
        >
          {workspace
            ? "Review recorded workspace read"
            : props.instructions === undefined
              ? "Review saved PR read"
              : "Suggest and review saved PR answer"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canRead || busy}
          onClick={() => void lookup(false)}
        >
          Read step status
        </Button>
      </div>
      {review ? (
        <div aria-label="Reviewed server-owned step" className="space-y-2">
          <p>
            {review.toolId}; arguments {review.argumentsJson}; revision {review.revision};{" "}
            {review.modelSelection.instanceId} / {review.modelSelection.model}; workspace{" "}
            {review.workspace}; maximum {review.maxCalls} call, {review.maxResultBytes} result
            bytes.
          </p>
          <p>
            Instructions: {review.reviewedIntent?.text ?? prompt}. Schema: {review.schemaDigest}.
          </p>
          {review.reviewedIntent ? (
            <p>
              Interpreted question:{" "}
              {
                {
                  workspace: "Recorded workspace and branch",
                  summary: "Saved PR summary",
                  open: "Which saved PRs are open",
                  draft: "Which saved PRs are drafts",
                }[review.reviewedIntent.question ?? "summary"]
              }
              {review.version === "server-owned-workspace-read.v1"
                ? ". Recorded metadata only; no filesystem or Git freshness established."
                : ". Saved status has not been refreshed from GitHub. Open state and draft flag are independent; missing values remain unknown. This does not establish merge readiness."}
            </p>
          ) : null}
          {review.reviewedIntent ? (
            <>
              <p>
                Suggested by the existing Auto router using local rules; this is not an
                optimal-model guarantee. Confirmed route: {review.reviewedIntent.routingBasisDigest}
                . The thread’s Manual model setting is preserved.
              </p>
              <p>{review.reviewedIntent.route.modelRoute?.explanation}</p>
              <SelectionBasisReadout
                basis={review.reviewedIntent.route.modelRoute?.selectionBasis}
              />
            </>
          ) : null}
          <p>
            Run {review.runId}; attempt {review.attemptId}; expires {review.expiresAt}. This
            proposal grants no execution until admitted.
          </p>
          <Button size="sm" disabled={busy || !eligible} onClick={() => void run()}>
            {workspace ? "Start reviewed workspace read" : "Run reviewed saved PR step"}
          </Button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {state ? (
        <div aria-label="Persisted capability result">
          <p>
            Operation: {state.status}. Source: {state.source}. {state.detail}
          </p>
          <p>
            {state.review.toolId}; original command {state.review.commandId}; run{" "}
            {state.review.runId}; attempt {state.review.attemptId}.
          </p>
          <p>
            Operation success does not mean the model completed or the task was accepted. Read the
            task result or conversation for the model outcome.
          </p>
          <p>
            Observed: {state.observedAt ?? "No proven result"}. Digest:{" "}
            {state.resultDigest ?? "Unavailable"}.
          </p>
          {state.resultJson ? (
            <pre className="whitespace-pre-wrap wrap-anywhere">{state.resultJson}</pre>
          ) : null}
        </div>
      ) : null}
      {props.onOpen ? (
        <Button size="sm" variant="outline" onClick={props.onOpen} disabled={busy}>
          Open conversation and results
        </Button>
      ) : null}
    </section>
  );
}
