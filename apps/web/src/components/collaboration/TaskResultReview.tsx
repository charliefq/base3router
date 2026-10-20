import {
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ThreadId,
  type CollaborationSnapshot,
  type CollaborationTask,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  completeResultText,
  revisionTaskKey,
  sameRevisionFacts,
  sameRevisionProjection,
  type RevisionRequestFacts,
} from "@t3tools/shared/taskRevisionRequest";
import { usePreparedConnection } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readTaskResultReview } from "./readTaskResultReview";
import { Button } from "../ui/button";

type View = {
  version: number;
  open: boolean;
  facts: RevisionRequestFacts | null;
  notice: string | null;
};
const Context = createContext<{
  version: number;
  validate: () => Promise<boolean>;
  matches: (facts: RevisionRequestFacts) => boolean;
  panel: ReactNode;
} | null>(null);
export const useTaskResultReview = () => useContext(Context);
export function TaskResultReviewPanel() {
  return useTaskResultReview()?.panel ?? null;
}
export function TaskResultReviewScope(props: {
  task: CollaborationTask;
  environmentId: EnvironmentId;
  stale: boolean;
  readVersion: number;
  readCollaboration: () => Promise<CollaborationSnapshot>;
  children: ReactNode;
}) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const readReview = useAtomCommand(threadEnvironment.readTaskReview, { reportFailure: false });
  const readProjection = useAtomCommand(threadEnvironment.readProjection, { reportFailure: false });
  const key = `${props.environmentId}:${props.readVersion}:${props.stale}:${revisionTaskKey(props.task)}`;
  const [scope, setScope] = useState({ key, session });
  if (scope.key !== key || scope.session !== session) setScope({ key, session });
  const [view, setView] = useState<View>({ version: 0, open: false, facts: null, notice: null });
  const [busy, setBusy] = useState(false);
  const viewRef = useRef(view),
    currentScope = useRef(scope),
    latest = useRef(props),
    mounted = useRef(true),
    owner = useRef<object | null>(null);
  const detail = useEnvironmentThread(
    props.environmentId,
    view.open && props.task.threadId ? ThreadId.make(props.task.threadId) : null,
  );
  const live = Option.getOrNull(detail.data);
  const latestLive = useRef(live),
    observedLive = useRef(live);
  const replace = useCallback(
    (open: boolean, facts: RevisionRequestFacts | null, notice: string | null) => {
      const next = { open, facts, notice, version: viewRef.current.version + 1 };
      viewRef.current = next;
      owner.current = null;
      setBusy(false);
      setView(next);
    },
    [],
  );
  useLayoutEffect(() => {
    latest.current = props;
    latestLive.current = live;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    currentScope.current = scope;
    replace(false, null, null);
    return () => {
      mounted.current = false;
      owner.current = null;
    };
  }, [scope, replace]);
  useLayoutEffect(() => {
    if (view.facts && live && live !== observedLive.current) {
      observedLive.current = live;
      if (!sameRevisionProjection(view.facts.projection, live))
        replace(
          true,
          null,
          "Persisted result evidence changed. Reload complete output before deciding.",
        );
    }
  }, [live, view.facts, replace]);
  const current = () =>
    mounted.current &&
    currentScope.current === scope &&
    viewRef.current === view &&
    !latest.current.stale &&
    session !== null;
  const unavailable =
    "Complete persisted output is unavailable: current ownership, contract and a unique completed result could not be confirmed. No excerpt is presented as complete text.";
  const load = async () => {
    if (!current() || owner.current) return;
    replace(true, null, null);
    const token = {};
    owner.current = token;
    setBusy(true);
    try {
      const facts = await readTaskResultReview(latest.current, readReview, readProjection);
      if (
        !mounted.current ||
        currentScope.current !== scope ||
        owner.current !== token ||
        latest.current.stale
      )
        return;
      observedLive.current = latestLive.current;
      replace(true, facts, facts ? null : unavailable);
    } catch {
      if (mounted.current && currentScope.current === scope && owner.current === token)
        replace(true, null, unavailable);
    }
  };
  const matches = (facts: RevisionRequestFacts) => {
    if (!current()) return false;
    if (!view.open) return true;
    if (view.facts && sameRevisionFacts(view.facts, facts)) return true;
    replace(
      true,
      null,
      "Persisted full output changed or is unavailable. Reload complete output before deciding.",
    );
    return false;
  };
  const validate = async () => {
    if (!current()) return false;
    if (!view.open) return true;
    if (!view.facts) return false;
    try {
      const facts = await readTaskResultReview(latest.current, readReview, readProjection);
      if (!current()) return false;
      if (facts && sameRevisionFacts(view.facts, facts)) return true;
    } catch {
      if (!current()) return false;
    }
    replace(
      true,
      null,
      "Persisted full output changed or is unavailable. Reload complete output before deciding.",
    );
    return false;
  };
  const facts = view.facts,
    result = facts?.result;
  const panel = (
    <section
      aria-label="Complete persisted output review"
      className="space-y-3 rounded-lg border border-border p-3"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.stale || !session || busy}
        onClick={load}
      >
        {view.open ? "Reload complete output" : "Open complete output"}
      </Button>
      {busy ? <p role="status">Reading complete persisted output…</p> : null}
      {view.notice ? <p role="status">{view.notice}</p> : null}
      {view.open ? (
        <>
          {facts && result ? (
            <>
              <h3>Complete persisted assistant output</h3>
              <p>
                Persisted output alone does not establish an accepted answer. Owner acceptance is a
                separate explicit decision.
              </p>
              <dl>
                <dt>Persisted Goal</dt>
                <dd>{facts.review.contract.goal}</dd>
                <dt>Persisted Redirect</dt>
                <dd>{facts.review.contract.redirect}</dd>
                <dt>Persisted Acceptance criteria</dt>
                <dd>{facts.review.contract.acceptance}</dd>
              </dl>
              <p>
                Owner {facts.task.ownerAgentId}; environment {props.environmentId}; project{" "}
                {facts.task.projectId}; task {facts.task.id}; thread {facts.task.threadId}; contract
                revision {facts.review.contract.revision}.
              </p>
              <p>
                Run {result.runId}; message {result.messageId}; attempt {result.attemptId}; turn{" "}
                {result.providerTurnId}; item {result.content.itemId}.
              </p>
              <pre
                aria-label="Complete persisted assistant text"
                className="whitespace-pre-wrap break-words text-sm"
              >
                {completeResultText(facts)}
              </pre>
            </>
          ) : !busy ? (
            <p>No complete text is currently confirmed.</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (currentScope.current === scope && viewRef.current === view)
                replace(false, null, null);
            }}
          >
            Close complete output
          </Button>
        </>
      ) : (
        <p>
          Open to read the complete attributable persisted text beside its criteria. Reading starts
          no work and records no acceptance or feedback.
        </p>
      )}
    </section>
  );
  return (
    <Context.Provider value={{ version: view.version, validate, matches, panel }}>
      {props.children}
    </Context.Provider>
  );
}
