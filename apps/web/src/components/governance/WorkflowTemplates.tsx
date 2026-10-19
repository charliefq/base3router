import {
  WorkflowActionInput,
  WorkflowTemplateDraft,
  WorkflowStage as WorkflowStageSchema,
  type WorkflowCatalog,
  type WorkflowStage,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { workflowCompositionIssue } from "@t3tools/shared/workflowComposition";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { workflowEnvironment } from "../../state/workflow";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

const Draft = Schema.Struct({
  ...WorkflowTemplateDraft.fields,
  displayName: Schema.String.check(Schema.isMaxLength(80)),
  description: Schema.String.check(Schema.isMaxLength(400)),
  stages: Schema.Array(
    Schema.Struct({
      ...WorkflowStageSchema.fields,
      label: Schema.String.check(Schema.isMaxLength(80)),
    }),
  ).check(Schema.isMaxLength(12)),
});
const Retained = Schema.Struct({
  draft: Schema.NullOr(Draft),
  expectedVersion: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
  selection: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
    }),
  ),
  command: Schema.NullOr(WorkflowActionInput),
});
type Retained = typeof Retained.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Retained));
const encode = Schema.encodeSync(Schema.fromJsonString(Retained));
const empty: Retained = { draft: null, expectedVersion: 0, selection: null, command: null };
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
function read(key: string, projectId: ProjectId) {
  try {
    const raw = globalThis.sessionStorage.getItem(key);
    const value = raw === null ? empty : decode(raw);
    if (
      value.command &&
      (!onlyTemplateCommand(value.command) || value.command.projectId !== projectId)
    )
      throw new Error();
    return { value, error: null };
  } catch {
    return {
      value: empty,
      error: "Workflow recovery storage is unavailable or invalid. Writes remain blocked.",
    };
  }
}
const onlyTemplateCommand = (command: WorkflowActionInput) =>
  command.type === "template.save" || command.type === "run.start";

export function WorkflowTemplates(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  catalog: WorkflowCatalog;
  fresh: boolean;
  refresh: () => void;
}) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const [identity, setIdentity] = useState({ session, revision: 0 });
  if (identity.session !== session) setIdentity({ session, revision: identity.revision + 1 });
  return (
    <TemplateEditor
      {...props}
      key={JSON.stringify([props.environmentId, props.projectId, identity.revision])}
      session={session}
    />
  );
}
function TemplateEditor(props: Parameters<typeof WorkflowTemplates>[0] & { session: unknown }) {
  const storageKey = `t3:workflow-template-editor:v1:${JSON.stringify([props.environmentId, props.projectId])}`;
  const [initial] = useState(() => read(storageKey, props.projectId));
  const [retained, setRetained] = useState(initial.value);
  const retainedRef = useRef(retained);
  const [notice, setNotice] = useState<string | null>(
    initial.error ??
      (initial.value.command
        ? "Original command outcome UNKNOWN after recovery. Check it without resending."
        : null),
  );
  const [blocked, setBlocked] = useState(initial.error !== null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const action = useAtomCommand(workflowEnvironment.action, { reportFailure: false });
  const status = useAtomCommand(workflowEnvironment.templateCommandStatus, {
    reportFailure: false,
  });
  const { catalog } = props;
  const roles = catalog.profiles.filter((p) => p.origin === "built-in" && p.projectId === null);
  const facts = JSON.stringify([
    catalog.reusableTemplatesVersion,
    catalog.templates.map((t) => [t.id, t.version, t.projectId, t.status, t.updatedAt]),
    catalog.templates.filter((t) => t.id === retained.selection?.id || t.id === retained.draft?.id),
    roles,
    catalog.runs.map((r) => [r.id, r.projectId, r.status, r.updatedAt]),
    props.fresh,
  ]);
  // A-B-A external facts retire ownership even when text/selection are restored.
  // eslint-disable-next-line react/preserve-manual-memoization
  const token = useMemo(() => Symbol(facts), [facts]);
  type Review = { token: symbol; command: WorkflowActionInput };
  const [review, setReview] = useState<Review | null>(null);
  const reviewRef = useRef<Review | null>(null);
  const owner = useRef<symbol | null>(token);
  useLayoutEffect(() => {
    owner.current = token;
    reviewRef.current = null;
    pending.current = false;
    // External facts retire confirmation, never the retained inert draft or original command.
    // eslint-disable-next-line react/set-state-in-effect
    setReview(null);
    setBusy(false);
    return () => {
      owner.current = null;
      reviewRef.current = null;
    };
  }, [token]);
  const persist = (next: Retained) => {
    try {
      const raw = encode(next);
      globalThis.sessionStorage.setItem(storageKey, raw);
      if (globalThis.sessionStorage.getItem(storageKey) !== raw) throw new Error();
      setBlocked(false);
      retainedRef.current = next;
      setRetained(next);
      return true;
    } catch {
      setBlocked(true);
      setNotice(
        "Workflow recovery storage could not be updated. Mutation controls remain blocked.",
      );
      return false;
    }
  };
  const editable =
    props.fresh &&
    !!props.session &&
    catalog.reusableTemplatesVersion === 1 &&
    !blocked &&
    !retained.command &&
    !busy;
  const templates = catalog.templates.filter(
    (t) => t.projectId === null || t.projectId === props.projectId,
  );
  const selected = templates.find(
    (t) => t.id === retained.selection?.id && t.version === retained.selection.version,
  );
  const selectedIssue = selected
    ? selected.status === "active"
      ? selected.origin === "built-in"
        ? null
        : workflowCompositionIssue(selected, roles)
      : "The selected template version is archived."
    : "Choose an exact saved template version.";
  const draft = retained.draft;
  const latest = draft
    ? templates.filter((t) => t.id === draft.id).toSorted((a, b) => b.version - a.version)[0]
    : undefined;
  const draftIssue = draft
    ? (workflowCompositionIssue(draft, roles) ??
      ((latest?.version ?? 0) !== retained.expectedVersion ||
      latest?.status === "archived" ||
      retained.expectedVersion >= 10000
        ? "The draft's expected version is stale or archived. Select the current saved version and review again."
        : null))
    : "Create or edit a draft.";
  const openRun = catalog.runs.some(
    (r) => r.projectId === props.projectId && (r.status === "active" || r.status === "paused"),
  );
  const change = (next: Retained) => {
    if (!editable || owner.current !== token) return;
    reviewRef.current = null;
    setReview(null);
    setNotice(null);
    persist(next);
  };
  const changeDraft = (next: WorkflowTemplateDraft) =>
    change({ ...retainedRef.current, draft: next });
  const relink = (stages: ReadonlyArray<WorkflowStage>) =>
    stages.map((s, index) => ({ ...s, nextStageId: stages[index + 1]?.id ?? null }));
  const stageChange = (index: number, stage: WorkflowStage) => {
    if (!draft) return;
    changeDraft({
      ...draft,
      stages: relink(draft.stages.map((s, i) => (i === index ? stage : s))),
    });
  };
  const prepare = (kind: "save" | "run") => {
    if (!editable || owner.current !== token || pending.current) return;
    let command: WorkflowActionInput;
    if (kind === "save") {
      if (!draft || draftIssue) return;
      command = {
        type: "template.save",
        projectId: props.projectId,
        commandId: id("workflow_save"),
        draft,
        expectedVersion: retained.expectedVersion,
      };
    } else {
      if (!selected || selectedIssue || openRun) return;
      command = {
        type: "run.start",
        projectId: props.projectId,
        commandId: id("workflow_create"),
        runId: id("workflow_run"),
        templateId: selected.id,
        templateVersion: selected.version,
        originatingThreadId: null,
        originatingMessageId: null,
      };
    }
    const next = { token, command };
    reviewRef.current = next;
    setReview(next);
  };
  const reconcile = async (command: WorkflowActionInput, value: symbol) => {
    const result = await status({ environmentId: props.environmentId, input: command });
    if (owner.current !== value) return;
    if (result._tag !== "Success") {
      setNotice("Original command remains UNKNOWN; no resend was made.");
      return;
    }
    if (result.value === "committed") {
      const state = retainedRef.current;
      if (state.command?.commandId !== command.commandId) return;
      if (
        persist({
          ...state,
          command: null,
          ...(command.type === "template.save" ? { draft: null, expectedVersion: 0 } : {}),
        })
      ) {
        setNotice(
          "Original command committed. Refresh and separately review the saved version or ledger.",
        );
        props.refresh();
      } else
        setNotice(
          "Original command is committed; recovery storage could not be updated. Retained identity remains blocked; no resend.",
        );
    } else
      setNotice(
        result.value === "conflict"
          ? "Original command conflicts. Mutation controls remain blocked."
          : "Original command is UNKNOWN. Reconcile only; no resend or replacement identity was created.",
      );
  };
  const confirm = async () => {
    if (
      !review ||
      reviewRef.current !== review ||
      owner.current !== review.token ||
      !editable ||
      pending.current
    )
      return;
    pending.current = true;
    setBusy(true);
    const value = review.token;
    const next = { ...retainedRef.current, command: review.command };
    if (!persist(next)) {
      setNotice("Original command identity could not be retained. No mutation was sent.");
      pending.current = false;
      setBusy(false);
      return;
    }
    reviewRef.current = null;
    setReview(null);
    setNotice("Original command pending / UNKNOWN. No provider starts here.");
    try {
      const result = await action({ environmentId: props.environmentId, input: review.command });
      if (owner.current === null) return;
      if (result._tag === "Success") await reconcile(review.command, owner.current);
      else
        setNotice(
          "Save or ledger creation failed or its reply was lost / UNKNOWN. Check the original command; no automatic resend.",
        );
    } catch {
      if (owner.current === value)
        setNotice("Original command remains UNKNOWN after a lost reply. No automatic resend.");
    } finally {
      if (owner.current === value) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="Workflow templates" className="space-y-3 border-t pt-3">
      <h3>Workflow templates</h3>
      <p>
        Save a reusable supervised sequence, then separately choose its exact saved version to
        create a ledger. Each stage still requires fresh model review, explicit Start, actual output
        and human approval.
      </p>
      {catalog.reusableTemplatesVersion !== 1 ? (
        <p>Reusable workflow editing is unavailable on this server.</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {retained.command ? (
        <div>
          <p>
            Original {retained.command.type} command {retained.command.commandId} is retained for
            read-only reconciliation. No automatic resend.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy || !props.fresh || !props.session}
            onClick={() => {
              if (pending.current || owner.current !== token) return;
              pending.current = true;
              setBusy(true);
              void reconcile(retained.command!, token).finally(() => {
                if (owner.current === token) {
                  pending.current = false;
                  setBusy(false);
                }
              });
            }}
          >
            Check original workflow command
          </Button>
        </div>
      ) : null}
      <label>
        Saved template/version
        <Select
          value={retained.selection ? `${retained.selection.id}@${retained.selection.version}` : ""}
          disabled={!editable}
          onValueChange={(value) => {
            const t = templates.find((t) => `${t.id}@${t.version}` === value);
            if (t) change({ ...retained, selection: { id: t.id, version: t.version } });
          }}
        >
          <SelectTrigger aria-label="Saved workflow version">
            <SelectValue placeholder="Choose a saved version" />
          </SelectTrigger>
          <SelectPopup>
            {templates.map((t) => (
              <SelectItem key={`${t.id}@${t.version}`} value={`${t.id}@${t.version}`}>
                {t.displayName} · v{t.version} · {t.status}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      {selected ? (
        <div>
          <p>
            {selected.displayName} · {selected.id} · v{selected.version} · {selected.status}
          </p>
          <p>{selected.description}</p>
          <ol>
            {selected.stages.map((s) => (
              <li key={s.id}>
                {s.label} · {s.type} · {s.profileId ?? "Human"}{" "}
                {s.profileVersion ? `v${s.profileVersion}` : ""} · approval required
                <pre className="whitespace-pre-wrap break-all">{s.taskPromptTemplate}</pre>
                <p>Output: {s.requiredOutputSections.join(", ") || "Human decision"}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {selectedIssue ? <p>{selectedIssue}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!editable}
          onClick={() =>
            change({
              ...retained,
              draft: { id: id("workflow"), displayName: "", description: "", stages: [] },
              expectedVersion: 0,
            })
          }
        >
          New workflow draft
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!editable}
          onClick={() => {
            const t = templates.find(
              (t) => t.origin === "built-in" && t.id === "saas-production" && t.version === 1,
            );
            if (!t) {
              setNotice("Built-in source version unavailable; no fallback.");
              return;
            }
            change({
              ...retained,
              draft: {
                id: id("workflow"),
                displayName: `${t.displayName} copy`,
                description: t.description,
                stages: t.stages.map((s) => {
                  if (s.type !== "agent") return s;
                  const p = roles.find(
                    (p) =>
                      p.id === s.profileId &&
                      p.version === s.profileVersion &&
                      p.status === "active",
                  );
                  return p
                    ? {
                        ...s,
                        artifactKind: p.artifactKind,
                        requiredOutputSections: p.requiredOutputSections,
                        capabilityPreferences: p.capabilityPreferences,
                      }
                    : s;
                }),
              },
              expectedVersion: 0,
            });
          }}
        >
          Copy SaaS Production v1
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !editable || !selected || selected.origin !== "custom" || selected.status !== "active"
          }
          onClick={() => {
            if (selected)
              change({
                ...retained,
                draft: {
                  id: selected.id,
                  displayName: selected.displayName,
                  description: selected.description,
                  stages: selected.stages,
                },
                expectedVersion: selected.version,
              });
          }}
        >
          Edit selected workflow version
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!editable || !!selectedIssue || openRun}
          onClick={() => prepare("run")}
        >
          Review ledger creation
        </Button>
      </div>
      {openRun ? (
        <p>
          This project already has an open workflow. Finish or cancel it before creating another.
        </p>
      ) : null}
      {draft ? (
        <div className="space-y-2">
          <p>
            Custom draft {draft.id} · expected version {retained.expectedVersion} → save v
            {retained.expectedVersion + 1}
          </p>
          <Input
            placeholder="Workflow name"
            aria-label="Workflow name"
            value={draft.displayName}
            maxLength={80}
            disabled={!editable}
            onChange={(e) => changeDraft({ ...draft, displayName: e.target.value })}
          />
          <Textarea
            placeholder="Describe this supervised workflow"
            aria-label="Workflow description"
            value={draft.description}
            maxLength={400}
            disabled={!editable}
            onChange={(e) => changeDraft({ ...draft, description: e.target.value })}
          />
          {draft.stages.map((s, index) => (
            <fieldset key={s.id} disabled={!editable} className="space-y-2 border p-2">
              <legend>Stage {index + 1}</legend>
              <Input
                placeholder="Stage name"
                aria-label={`Stage ${index + 1} name`}
                value={s.label}
                maxLength={80}
                onChange={(e) => stageChange(index, { ...s, label: e.target.value })}
              />
              <Select
                value={
                  s.type === "human_gate"
                    ? "human_gate"
                    : s.profileId
                      ? `${s.profileId}@${s.profileVersion}`
                      : ""
                }
                onValueChange={(value) => {
                  if (value === "human_gate")
                    stageChange(index, {
                      ...s,
                      type: "human_gate",
                      profileId: null,
                      profileVersion: null,
                      artifactKind: "human_decision",
                      requiredOutputSections: [],
                      capabilityPreferences: [],
                    });
                  else {
                    const p = roles.find(
                      (p) => `${p.id}@${p.version}` === value && p.status === "active",
                    );
                    if (p)
                      stageChange(index, {
                        ...s,
                        type: "agent",
                        profileId: p.id,
                        profileVersion: p.version,
                        artifactKind: p.artifactKind,
                        requiredOutputSections: p.requiredOutputSections,
                        capabilityPreferences: p.capabilityPreferences,
                      });
                  }
                }}
              >
                <SelectTrigger aria-label={`Stage ${index + 1} role`}>
                  <SelectValue placeholder="Choose exact built-in role or human gate" />
                </SelectTrigger>
                <SelectPopup>
                  {roles
                    .filter((p) => p.status === "active")
                    .map((p) => (
                      <SelectItem key={`${p.id}@${p.version}`} value={`${p.id}@${p.version}`}>
                        {p.displayName} v{p.version}
                      </SelectItem>
                    ))}
                  <SelectItem value="human_gate">Human gate</SelectItem>
                </SelectPopup>
              </Select>
              <Textarea
                placeholder="Bounded plain task instructions"
                aria-label={`Stage ${index + 1} instructions`}
                value={s.taskPromptTemplate}
                maxLength={4000}
                onChange={(e) => stageChange(index, { ...s, taskPromptTemplate: e.target.value })}
              />
              <p>
                Mandatory approval · maximum {s.maxAttempts} attempts · Output:{" "}
                {s.requiredOutputSections.join(", ") || "Human decision"}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={index === 0}
                onClick={() => {
                  const stages = [...draft.stages];
                  [stages[index - 1], stages[index]] = [stages[index]!, stages[index - 1]!];
                  changeDraft({ ...draft, stages: relink(stages) });
                }}
              >
                Move stage {index + 1} up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  changeDraft({
                    ...draft,
                    stages: relink(draft.stages.filter((_, i) => i !== index)),
                  })
                }
              >
                Remove stage {index + 1}
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            size="sm"
            disabled={!editable || draft.stages.length >= 12}
            onClick={() =>
              changeDraft({
                ...draft,
                stages: relink([
                  ...draft.stages,
                  {
                    id: id("stage"),
                    label: `Stage ${draft.stages.length + 1}`,
                    type: "agent",
                    profileId: null,
                    profileVersion: null,
                    artifactKind: "artifact",
                    requiredOutputSections: [],
                    approvalRequired: true,
                    nextStageId: null,
                    capabilityPreferences: [],
                    taskPromptTemplate: "",
                    maxAttempts: 3,
                  },
                ]),
              })
            }
          >
            Add stage
          </Button>
          {draftIssue ? <p>{draftIssue}</p> : null}
          <Button
            type="button"
            size="sm"
            disabled={!editable || !!draftIssue}
            onClick={() => prepare("save")}
          >
            Review workflow save
          </Button>
        </div>
      ) : null}
      {review ? (
        <section aria-label="Review workflow command">
          <p>
            {review.command.type === "template.save"
              ? `Save immutable v${review.command.expectedVersion + 1}, expected v${review.command.expectedVersion}`
              : `Create ledger using ${review.command.type === "run.start" ? `${review.command.templateId} v${review.command.templateVersion}` : ""}`}
          </p>
          <p>
            Command {review.command.commandId}. This starts no provider. Context changes retire this
            confirmation.
          </p>
          {review.command.type === "template.save" ? (
            <>
              <p>
                {review.command.draft.displayName} · {review.command.draft.description}
              </p>
              <ol>
                {review.command.draft.stages.map((s) => (
                  <li key={s.id}>
                    {s.label} · {s.profileId ?? "Human gate"}{" "}
                    {s.profileVersion ? `v${s.profileVersion}` : ""}
                    <pre className="whitespace-pre-wrap break-all">{s.taskPromptTemplate}</pre>
                    <p>
                      Output: {s.requiredOutputSections.join(", ") || "Human decision"} · approval
                      required
                    </p>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <Button type="button" size="sm" disabled={!editable} onClick={() => void confirm()}>
            Confirm workflow command
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              reviewRef.current = null;
              setReview(null);
            }}
          >
            Cancel workflow review
          </Button>
        </section>
      ) : null}
    </section>
  );
}
