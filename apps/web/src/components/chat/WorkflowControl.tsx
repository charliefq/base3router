import type {
  AgentProfile,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorkflowActionInput,
  WorkflowCatalog,
  WorkflowStage,
  WorkflowStagePreview,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";

import { workflowEnvironment } from "~/state/workflow";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type Tab = "runs" | "profiles" | "templates";
type StageDraft = Pick<
  WorkflowStage,
  | "id"
  | "label"
  | "type"
  | "profileId"
  | "profileVersion"
  | "artifactKind"
  | "requiredOutputSections"
  | "taskPromptTemplate"
  | "maxAttempts"
>;

const lines = (value: string) =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
const failureText = (cause: unknown) => {
  const error = Cause.squash(cause as Cause.Cause<unknown>);
  return error instanceof Error ? error.message : "The workflow request failed.";
};
const versionKey = (id: string, version: number) => `${id}@${version}`;
const newStage = (profile: AgentProfile | undefined): StageDraft => ({
  id: `stage-${randomUUID().slice(0, 8)}`,
  label: "New stage",
  type: "agent",
  profileId: profile?.id ?? null,
  profileVersion: profile?.version ?? null,
  artifactKind: profile?.artifactKind ?? "report",
  requiredOutputSections: profile?.requiredOutputSections ?? ["Result"],
  taskPromptTemplate: "Complete this stage and report the required sections.",
  maxAttempts: 3,
});

export function WorkflowControl(props: {
  readonly available: boolean;
  readonly environmentId: EnvironmentId;
  readonly project: { readonly id: ProjectId; readonly title: string } | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("runs");
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("saas-production@1");
  const [preview, setPreview] = useState<WorkflowStagePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preferredKey, setPreferredKey] = useState("");
  const [instruction, setInstruction] = useState("");
  const previewGeneration = useRef(0);
  const dispatchKey = useRef<{ readonly attemptKey: string; readonly id: string } | null>(null);
  const [profileEditKey, setProfileEditKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [profilePurpose, setProfilePurpose] = useState("");
  const [profileResponsibilities, setProfileResponsibilities] = useState("");
  const [profileExclusions, setProfileExclusions] = useState("");
  const [profileInstructions, setProfileInstructions] = useState("");
  const [profileSections, setProfileSections] = useState("Result");
  const [profileArtifactKind, setProfileArtifactKind] = useState("report");
  const [profileCapabilities, setProfileCapabilities] = useState<
    AgentProfile["capabilityPreferences"]
  >([]);
  const [templateEditKey, setTemplateEditKey] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [stages, setStages] = useState<StageDraft[]>([]);
  const runCatalog = useAtomCommand(workflowEnvironment.catalog, {
    reportFailure: false,
    reportDefect: false,
  });
  const runAction = useAtomCommand(workflowEnvironment.action, {
    reportFailure: false,
    reportDefect: false,
  });
  const runPreview = useAtomCommand(workflowEnvironment.previewStage, {
    reportFailure: false,
    reportDefect: false,
  });
  const runDispatch = useAtomCommand(workflowEnvironment.dispatchStage, {
    reportFailure: false,
    reportDefect: false,
  });
  const runPropose = useAtomCommand(workflowEnvironment.proposeArtifact, {
    reportFailure: false,
    reportDefect: false,
  });
  const projectId = props.project?.id ?? null;

  useEffect(() => {
    if (!open || projectId === null) return;
    let live = true;
    setLoading(true);
    void runCatalog({ environmentId: props.environmentId, input: { projectId } }).then((result) => {
      if (!live) return;
      setLoading(false);
      if (result._tag === "Failure") setError(failureText(result.cause));
      else {
        setCatalog(result.value);
        setError(null);
      }
    });
    return () => {
      live = false;
    };
  }, [open, projectId, props.environmentId, runCatalog]);

  const run = catalog?.runs.find((entry) => entry.id === selectedRunId) ?? null;
  const template =
    run &&
    catalog?.templates.find(
      (entry) => entry.id === run.templateId && entry.version === run.templateVersion,
    );
  const stage = template?.stages.find((entry) => entry.id === run?.currentStageId);
  const attempt = run?.attempts.findLast((entry) => entry.stageId === stage?.id);
  const stageKey = run && stage && attempt ? `${run.id}:${stage.id}:${attempt.attempt}` : "";

  useEffect(() => {
    if (
      !open ||
      projectId === null ||
      !run ||
      !stage ||
      !attempt ||
      stage.type !== "agent" ||
      attempt.status !== "pending"
    ) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    const generation = ++previewGeneration.current;
    setPreview(null);
    setPreviewLoading(true);
    const timer = window.setTimeout(() => {
      const [instanceId, model] = preferredKey.split("\u0000");
      void runPreview({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          projectId,
          runId: run.id,
          ...(instanceId && model
            ? {
                preferredRoute: {
                  instanceId:
                    instanceId as WorkflowStagePreview["route"]["candidates"][number]["target"]["instanceId"],
                  model,
                },
              }
            : {}),
        },
      }).then((result) => {
        if (previewGeneration.current !== generation) return;
        setPreviewLoading(false);
        if (result._tag === "Failure") {
          setError(failureText(result.cause));
          return;
        }
        setPreview(result.value);
        setError(null);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (previewGeneration.current === generation) previewGeneration.current += 1;
    };
  }, [open, projectId, props.environmentId, stageKey, preferredKey, runPreview]);

  if (!props.available || props.project === null) return null;

  const act = async (input: WorkflowActionInput) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await runAction({ environmentId: props.environmentId, input });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureText(result.cause));
      return;
    }
    setCatalog(result.value);
    if (input.type === "run.start") {
      setSelectedRunId(input.runId);
      setTab("runs");
    }
  };
  const refresh = async () => {
    if (projectId === null) return;
    setLoading(true);
    const result = await runCatalog({ environmentId: props.environmentId, input: { projectId } });
    setLoading(false);
    if (result._tag === "Failure") setError(failureText(result.cause));
    else {
      setCatalog(result.value);
      setError(null);
    }
  };
  const submitDecision = (value: "approve" | "reject" | "request_revision") => {
    if (!projectId || !run || !stage || !attempt) return;
    const artifact = run.artifacts.find(
      (entry) =>
        entry.stageId === stage.id &&
        entry.attempt === attempt.attempt &&
        entry.status === "proposed",
    );
    void act({
      type: "decision.record",
      projectId,
      commandId: randomUUID(),
      decisionId: randomUUID(),
      runId: run.id,
      stageId: stage.id,
      attempt: attempt.attempt,
      artifactId: artifact?.id ?? null,
      value,
    });
  };
  const selectedProfile = catalog?.profiles.find(
    (entry) => versionKey(entry.id, entry.version) === profileEditKey,
  );
  const selectedTemplateEdit = catalog?.templates.find(
    (entry) => versionKey(entry.id, entry.version) === templateEditKey,
  );
  const profileIsLatest =
    !selectedProfile ||
    selectedProfile.version ===
      Math.max(
        ...(catalog?.profiles
          .filter((entry) => entry.id === selectedProfile.id)
          .map((entry) => entry.version) ?? [0]),
      );
  const templateIsLatest =
    !selectedTemplateEdit ||
    selectedTemplateEdit.version ===
      Math.max(
        ...(catalog?.templates
          .filter((entry) => entry.id === selectedTemplateEdit.id)
          .map((entry) => entry.version) ?? [0]),
      );
  const activeProfiles = catalog?.profiles.filter((entry) => entry.status === "active") ?? [];
  const selectedRoute = preview?.route.selected;
  const eligibleRoutes = preview?.route.candidates.filter((candidate) => candidate.eligible) ?? [];
  const accepted = run?.artifacts.findLast((entry) => entry.status === "accepted");
  const proposed =
    stage && attempt
      ? run?.artifacts.find(
          (entry) => entry.stageId === stage.id && entry.attempt === attempt.attempt,
        )
      : null;

  const dispatch = async () => {
    if (
      busyRef.current ||
      !projectId ||
      !run ||
      !stage ||
      !attempt ||
      !selectedRoute ||
      preview?.route.gate.decision !== "ALLOW"
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const key = `${run.id}:${stage.id}:${attempt.attempt}`;
    if (dispatchKey.current?.attemptKey !== key)
      dispatchKey.current = { attemptKey: key, id: randomUUID() };
    const result = await runDispatch({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        projectId,
        runId: run.id,
        stageId: stage.id,
        attempt: attempt.attempt,
        dispatchId: dispatchKey.current.id,
        target: selectedRoute.target,
        additionalInstruction: instruction.slice(0, 2_000),
      },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureText(result.cause));
      return;
    }
    setCatalog(
      (previous) =>
        previous && {
          ...previous,
          runs: previous.runs.map((entry) =>
            entry.id === result.value.run.id ? result.value.run : entry,
          ),
        },
    );
    props.onOpenThread(result.value.threadId);
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Workflow
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          className="max-h-[min(90vh,52rem)] w-full max-w-3xl overflow-y-auto max-sm:max-h-[90vh]"
          bottomStickOnMobile={false}
        >
          <DialogTitle>Workflow · {props.project.title}</DialogTitle>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={tab === "runs" ? "default" : "outline"}
              onClick={() => setTab("runs")}
            >
              Runs
            </Button>
            <Button
              size="sm"
              variant={tab === "profiles" ? "default" : "outline"}
              onClick={() => setTab("profiles")}
            >
              Agent profiles
            </Button>
            <Button
              size="sm"
              variant={tab === "templates" ? "default" : "outline"}
              onClick={() => setTab("templates")}
            >
              Templates
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </div>
          {loading ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading authoritative workflow state…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {tab === "runs" && catalog ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="Workflow template"
                  className="h-8 rounded-md border border-input bg-background px-2"
                  value={selectedTemplate}
                  onChange={(event) => setSelectedTemplate(event.target.value)}
                >
                  {catalog.templates
                    .filter((entry) => entry.status === "active")
                    .map((entry) => (
                      <option
                        key={versionKey(entry.id, entry.version)}
                        value={versionKey(entry.id, entry.version)}
                      >
                        {entry.displayName} · v{entry.version}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const selected = catalog.templates.find(
                      (entry) => versionKey(entry.id, entry.version) === selectedTemplate,
                    );
                    if (selected)
                      void act({
                        type: "run.start",
                        projectId: props.project!.id,
                        commandId: randomUUID(),
                        runId: randomUUID(),
                        templateId: selected.id,
                        templateVersion: selected.version,
                        originatingThreadId: null,
                        originatingMessageId: null,
                      });
                  }}
                >
                  Start workflow
                </Button>
              </div>
              <p className="text-muted-foreground">
                Each stage needs explicit review before the next task. Agent roles are separate from
                provider runners.
              </p>
              <select
                aria-label="Workflow run"
                className="h-8 w-full rounded-md border border-input bg-background px-2"
                value={selectedRunId}
                onChange={(event) => {
                  setSelectedRunId(event.target.value);
                  setPreferredKey("");
                }}
              >
                <option value="">Select a run</option>
                {catalog.runs.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.templateId} · {entry.status} · {entry.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              {run && template ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border p-3">
                    <div className="font-medium">
                      {template.displayName} v{template.version} · {run.status}
                    </div>
                    <ol className="mt-2 space-y-1">
                      {template.stages.map((entry) => {
                        const latest = run.attempts.findLast(
                          (candidate) => candidate.stageId === entry.id,
                        );
                        return (
                          <li key={entry.id} className="flex flex-wrap gap-x-2">
                            <span>{entry.label}</span>
                            <span className="text-muted-foreground">
                              {latest?.status ?? "waiting"}
                              {latest?.profileId
                                ? ` · ${latest.profileId} v${latest.profileVersion}`
                                : ""}
                            </span>
                            {latest?.routeBinding ? (
                              <span>
                                Bound: {latest.routeBinding.target.instanceId} ·{" "}
                                {latest.routeBinding.target.model}
                              </span>
                            ) : null}
                            {latest?.destinationThreadId ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => props.onOpenThread(latest.destinationThreadId!)}
                              >
                                Open task
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                  {stage && attempt ? (
                    <div className="space-y-3 rounded-lg border border-border p-3">
                      <div className="font-medium">
                        Current: {stage.label} · attempt {attempt.attempt}
                      </div>
                      <div className="text-muted-foreground">
                        Role:{" "}
                        {stage.profileId ? `${stage.profileId} v${stage.profileVersion}` : "Human"}
                      </div>
                      {proposed ? (
                        <div className="space-y-2">
                          <div>
                            {proposed.status === "accepted"
                              ? "Accepted artifact"
                              : "Proposed artifact"}{" "}
                            · {proposed.kind} · source turn {proposed.sourceTurnId ?? "none"}
                          </div>
                          {proposed.missingSections.length > 0 ? (
                            <p className="text-warning-foreground">
                              Missing sections: {proposed.missingSections.join(", ")}
                            </p>
                          ) : null}
                          {proposed.sections.map((section) => (
                            <div key={section.label}>
                              <div className="font-medium">{section.label}</div>
                              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                                {section.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {stage.type === "agent" && attempt.status === "dispatched" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            if (!projectId) return;
                            busyRef.current = true;
                            setBusy(true);
                            const result = await runPropose({
                              environmentId: props.environmentId,
                              input: {
                                projectId,
                                runId: run.id,
                                artifactId: randomUUID(),
                                commandId: randomUUID(),
                              },
                            });
                            busyRef.current = false;
                            setBusy(false);
                            if (result._tag === "Failure") setError(failureText(result.cause));
                            else void refresh();
                          }}
                        >
                          Propose settled output
                        </Button>
                      ) : null}
                      {stage.type === "agent" && attempt.status === "pending" ? (
                        <div className="space-y-2">
                          <div>
                            {previewLoading
                              ? "Loading provisional route…"
                              : preview?.route.gate.decision === "ALLOW"
                                ? "Provisional route · confirm to bind"
                                : "No available runner for this stage"}
                          </div>
                          {preview ? (
                            <>
                              <p className="text-muted-foreground">
                                {preview.profile.displayName} v{preview.profile.version} ·{" "}
                                {preview.route.gate.reasonCodes.join(", ")}
                              </p>
                              <select
                                aria-label="Provisional provider route"
                                className="h-8 w-full rounded-md border border-input bg-background px-2"
                                value={
                                  selectedRoute
                                    ? `${selectedRoute.target.instanceId}\u0000${selectedRoute.target.model}`
                                    : ""
                                }
                                onChange={(event) => setPreferredKey(event.target.value)}
                              >
                                {eligibleRoutes.map((entry) => (
                                  <option
                                    key={`${entry.target.instanceId}:${entry.target.model}`}
                                    value={`${entry.target.instanceId}\u0000${entry.target.model}`}
                                  >
                                    {entry.target.instanceId} · {entry.target.model}
                                  </option>
                                ))}
                              </select>
                              <details>
                                <summary>Review stage packet</summary>
                                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                                  {preview.packetText}
                                </p>
                              </details>
                              <Textarea
                                aria-label="Additional stage instruction"
                                value={instruction}
                                maxLength={2_000}
                                onChange={(event) => setInstruction(event.target.value)}
                              />
                              <Button
                                size="sm"
                                disabled={
                                  busy || previewLoading || preview.route.gate.decision !== "ALLOW"
                                }
                                onClick={() => void dispatch()}
                              >
                                Confirm and start task
                              </Button>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                      {run.status === "active" &&
                      (stage.type === "human_gate" ||
                        stage.type === "manual" ||
                        attempt.status === "proposed") ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => submitDecision("approve")}
                          >
                            Accept and continue
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => submitDecision("request_revision")}
                          >
                            Request revision
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => submitDecision("reject")}
                          >
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {accepted ? (
                    <div className="text-muted-foreground">
                      Latest accepted artifact: {accepted.kind} · {accepted.stageId}
                    </div>
                  ) : null}
                  {run.status === "active" || run.status === "paused" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          type: "run.cancel",
                          projectId: props.project!.id,
                          commandId: randomUUID(),
                          runId: run.id,
                        })
                      }
                    >
                      Cancel run
                    </Button>
                  ) : null}
                  {run.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          type: "run.pause",
                          projectId: props.project!.id,
                          commandId: randomUUID(),
                          runId: run.id,
                        })
                      }
                    >
                      Pause
                    </Button>
                  ) : null}
                  {run.status === "paused" ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          type: "run.resume",
                          projectId: props.project!.id,
                          commandId: randomUUID(),
                          runId: run.id,
                        })
                      }
                    >
                      Resume
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {tab === "profiles" && catalog ? (
            <div className="mt-4 space-y-3 text-sm">
              <select
                aria-label="Edit agent profile"
                className="h-8 w-full rounded-md border border-input bg-background px-2"
                value={profileEditKey}
                onChange={(event) => {
                  const value = event.target.value;
                  setProfileEditKey(value);
                  const selected = catalog.profiles.find(
                    (entry) => versionKey(entry.id, entry.version) === value,
                  );
                  setProfileId(selected?.id ?? "");
                  setProfileName(selected?.displayName ?? "");
                  setProfileDescription(selected?.description ?? "");
                  setProfilePurpose(selected?.purpose ?? "");
                  setProfileResponsibilities(selected?.responsibilities.join("\n") ?? "");
                  setProfileExclusions(selected?.exclusions.join("\n") ?? "");
                  setProfileInstructions(selected?.instructions ?? "");
                  setProfileSections(selected?.requiredOutputSections.join("\n") ?? "Result");
                  setProfileArtifactKind(selected?.artifactKind ?? "report");
                  setProfileCapabilities(selected?.capabilityPreferences ?? []);
                }}
              >
                <option value="">New custom profile</option>
                {catalog.profiles.map((entry) => (
                  <option
                    key={versionKey(entry.id, entry.version)}
                    value={versionKey(entry.id, entry.version)}
                  >
                    {entry.displayName} · v{entry.version} · {entry.origin}
                    {entry.status === "archived" ? " · archived" : ""}
                  </option>
                ))}
              </select>
              {selectedProfile?.origin === "built-in" ? (
                <p>
                  {selectedProfile.purpose} · Expected:{" "}
                  {selectedProfile.requiredOutputSections.join(", ")}
                </p>
              ) : (
                <div className="space-y-2">
                  {!profileIsLatest ? (
                    <p className="text-muted-foreground">Historical version is read-only.</p>
                  ) : null}
                  <Input
                    aria-label="Profile ID"
                    placeholder="stable-profile-id"
                    value={profileId}
                    disabled={Boolean(selectedProfile)}
                    onChange={(event) => setProfileId(event.target.value)}
                  />
                  <Input
                    aria-label="Profile name"
                    placeholder="Role name"
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                  />
                  <Input
                    aria-label="Profile description"
                    placeholder="Short description"
                    value={profileDescription}
                    onChange={(event) => setProfileDescription(event.target.value)}
                  />
                  <Input
                    aria-label="Profile purpose"
                    placeholder="Role purpose"
                    value={profilePurpose}
                    onChange={(event) => setProfilePurpose(event.target.value)}
                  />
                  <Textarea
                    aria-label="Profile responsibilities"
                    placeholder="One responsibility per line"
                    value={profileResponsibilities}
                    onChange={(event) => setProfileResponsibilities(event.target.value)}
                  />
                  <Textarea
                    aria-label="Profile exclusions"
                    placeholder="One exclusion per line"
                    value={profileExclusions}
                    onChange={(event) => setProfileExclusions(event.target.value)}
                  />
                  <Textarea
                    aria-label="Profile instructions"
                    placeholder="Bounded role instructions"
                    value={profileInstructions}
                    maxLength={8_000}
                    onChange={(event) => setProfileInstructions(event.target.value)}
                  />
                  <Textarea
                    aria-label="Required output sections"
                    value={profileSections}
                    onChange={(event) => setProfileSections(event.target.value)}
                  />
                  <Input
                    aria-label="Artifact kind"
                    value={profileArtifactKind}
                    onChange={(event) => setProfileArtifactKind(event.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        "web-research",
                        "long-context-repository",
                        "backend-correctness",
                        "ui-implementation",
                        "independent-review",
                      ] as const
                    ).map((capability) => (
                      <label key={capability} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={profileCapabilities.includes(capability)}
                          onChange={(event) =>
                            setProfileCapabilities(
                              event.target.checked
                                ? [...profileCapabilities, capability]
                                : profileCapabilities.filter((entry) => entry !== capability),
                            )
                          }
                        />
                        {capability}
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !profileIsLatest ||
                        !profileId ||
                        !profileName ||
                        !profilePurpose ||
                        !profileInstructions ||
                        selectedProfile?.status === "archived"
                      }
                      onClick={() => {
                        if (!projectId) return;
                        void act({
                          type: "profile.save",
                          projectId,
                          commandId: randomUUID(),
                          expectedVersion: selectedProfile?.version ?? 0,
                          draft: {
                            id: profileId,
                            displayName: profileName,
                            description: profileDescription || profilePurpose,
                            purpose: profilePurpose,
                            responsibilities: lines(profileResponsibilities),
                            exclusions: lines(profileExclusions),
                            instructions: profileInstructions,
                            requiredOutputSections: lines(profileSections),
                            artifactKind: profileArtifactKind,
                            capabilityPreferences: profileCapabilities,
                          },
                        });
                      }}
                    >
                      Save new version
                    </Button>
                    {selectedProfile && selectedProfile.status === "active" && profileIsLatest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (projectId)
                            void act({
                              type: "profile.archive",
                              projectId,
                              commandId: randomUUID(),
                              profileId: selectedProfile.id,
                            });
                        }}
                      >
                        Archive
                      </Button>
                    ) : null}
                    {selectedProfile && selectedProfile.status === "archived" && profileIsLatest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (projectId)
                            void act({
                              type: "profile.restore",
                              projectId,
                              commandId: randomUUID(),
                              profileId: selectedProfile.id,
                            });
                        }}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {tab === "templates" && catalog ? (
            <div className="mt-4 space-y-3 text-sm">
              <select
                aria-label="Edit workflow template"
                className="h-8 w-full rounded-md border border-input bg-background px-2"
                value={templateEditKey}
                onChange={(event) => {
                  const value = event.target.value;
                  setTemplateEditKey(value);
                  const selected = catalog.templates.find(
                    (entry) => versionKey(entry.id, entry.version) === value,
                  );
                  if (selected) {
                    setTemplateId(selected.id);
                    setTemplateName(selected.displayName);
                    setTemplateDescription(selected.description);
                    setStages(
                      selected.stages.map((entry) => ({
                        id: entry.id,
                        label: entry.label,
                        type: entry.type,
                        profileId: entry.profileId,
                        profileVersion: entry.profileVersion,
                        artifactKind: entry.artifactKind,
                        requiredOutputSections: entry.requiredOutputSections,
                        taskPromptTemplate: entry.taskPromptTemplate,
                        maxAttempts: entry.maxAttempts,
                      })),
                    );
                  } else {
                    setTemplateId("");
                    setTemplateName("");
                    setTemplateDescription("");
                    setStages([]);
                  }
                }}
              >
                <option value="">New custom template</option>
                {catalog.templates.map((entry) => (
                  <option
                    key={versionKey(entry.id, entry.version)}
                    value={versionKey(entry.id, entry.version)}
                  >
                    {entry.displayName} · v{entry.version} · {entry.origin}
                    {entry.status === "archived" ? " · archived" : ""}
                  </option>
                ))}
              </select>
              {selectedTemplateEdit?.origin === "built-in" ? (
                <p>
                  {selectedTemplateEdit.description} ·{" "}
                  {selectedTemplateEdit.stages.map((entry) => entry.label).join(" → ")}
                </p>
              ) : (
                <>
                  <Input
                    aria-label="Template ID"
                    placeholder="stable-template-id"
                    value={templateId}
                    disabled={Boolean(selectedTemplateEdit)}
                    onChange={(event) => setTemplateId(event.target.value)}
                  />
                  <Input
                    aria-label="Template name"
                    placeholder="Workflow name"
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                  />
                  <Input
                    aria-label="Template description"
                    placeholder="Short description"
                    value={templateDescription}
                    onChange={(event) => setTemplateDescription(event.target.value)}
                  />
                  {stages.map((entry, index) => (
                    <div
                      key={`${entry.id}:${index}`}
                      className="space-y-2 rounded-lg border border-border p-3"
                    >
                      <div className="flex gap-2">
                        <Input
                          aria-label={`Stage ${index + 1} ID`}
                          value={entry.id}
                          onChange={(event) =>
                            setStages(
                              stages.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, id: event.target.value }
                                  : candidate,
                              ),
                            )
                          }
                        />
                        <Input
                          aria-label={`Stage ${index + 1} label`}
                          value={entry.label}
                          onChange={(event) =>
                            setStages(
                              stages.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? { ...candidate, label: event.target.value }
                                  : candidate,
                              ),
                            )
                          }
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <select
                          aria-label={`Stage ${index + 1} type`}
                          className="h-8 rounded-md border border-input bg-background px-2"
                          value={entry.type}
                          onChange={(event) =>
                            setStages(
                              stages.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? {
                                      ...candidate,
                                      type: event.target.value as WorkflowStage["type"],
                                      profileId:
                                        event.target.value === "agent"
                                          ? (activeProfiles[0]?.id ?? null)
                                          : null,
                                      profileVersion:
                                        event.target.value === "agent"
                                          ? (activeProfiles[0]?.version ?? null)
                                          : null,
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        >
                          <option value="agent">Agent</option>
                          <option value="human_gate">Human gate</option>
                          <option value="manual">Manual</option>
                        </select>
                        {entry.type === "agent" ? (
                          <select
                            aria-label={`Stage ${index + 1} profile`}
                            className="h-8 rounded-md border border-input bg-background px-2"
                            value={
                              entry.profileId && entry.profileVersion
                                ? versionKey(entry.profileId, entry.profileVersion)
                                : ""
                            }
                            onChange={(event) => {
                              const profile = activeProfiles.find(
                                (candidate) =>
                                  versionKey(candidate.id, candidate.version) ===
                                  event.target.value,
                              );
                              setStages(
                                stages.map((candidate, candidateIndex) =>
                                  candidateIndex === index
                                    ? {
                                        ...candidate,
                                        profileId: profile?.id ?? null,
                                        profileVersion: profile?.version ?? null,
                                        artifactKind:
                                          profile?.artifactKind ?? candidate.artifactKind,
                                        requiredOutputSections:
                                          profile?.requiredOutputSections ??
                                          candidate.requiredOutputSections,
                                      }
                                    : candidate,
                                ),
                              );
                            }}
                          >
                            {activeProfiles.map((profile) => (
                              <option
                                key={versionKey(profile.id, profile.version)}
                                value={versionKey(profile.id, profile.version)}
                              >
                                {profile.displayName} v{profile.version}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setStages(
                              stages.filter((_, candidateIndex) => candidateIndex !== index),
                            )
                          }
                        >
                          Remove
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={index === 0}
                          onClick={() =>
                            setStages(
                              stages.map((candidate, candidateIndex) =>
                                candidateIndex === index - 1
                                  ? stages[index]!
                                  : candidateIndex === index
                                    ? stages[index - 1]!
                                    : candidate,
                              ),
                            )
                          }
                        >
                          Move up
                        </Button>
                      </div>
                      <Input
                        aria-label={`Stage ${index + 1} artifact kind`}
                        value={entry.artifactKind}
                        onChange={(event) =>
                          setStages(
                            stages.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, artifactKind: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                      />
                      <Textarea
                        aria-label={`Stage ${index + 1} required sections`}
                        value={entry.requiredOutputSections.join("\n")}
                        onChange={(event) =>
                          setStages(
                            stages.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? {
                                    ...candidate,
                                    requiredOutputSections: lines(event.target.value),
                                  }
                                : candidate,
                            ),
                          )
                        }
                      />
                      <Textarea
                        aria-label={`Stage ${index + 1} task prompt`}
                        maxLength={4_000}
                        value={entry.taskPromptTemplate}
                        onChange={(event) =>
                          setStages(
                            stages.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, taskPromptTemplate: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={stages.length >= 12}
                      onClick={() => setStages([...stages, newStage(activeProfiles[0])])}
                    >
                      Add stage
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !templateId ||
                        !templateName ||
                        stages.length === 0 ||
                        selectedTemplateEdit?.status === "archived" ||
                        !templateIsLatest
                      }
                      onClick={() => {
                        if (!projectId) return;
                        void act({
                          type: "template.save",
                          projectId,
                          commandId: randomUUID(),
                          expectedVersion: selectedTemplateEdit?.version ?? 0,
                          draft: {
                            id: templateId,
                            displayName: templateName,
                            description: templateDescription || templateName,
                            stages: stages.map((entry, index) => ({
                              ...entry,
                              nextStageId: stages[index + 1]?.id ?? null,
                              approvalRequired: true,
                              capabilityPreferences: [],
                            })),
                          },
                        });
                      }}
                    >
                      Save template version
                    </Button>
                    {selectedTemplateEdit?.status === "active" && templateIsLatest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          if (projectId)
                            void act({
                              type: "template.archive",
                              projectId,
                              commandId: randomUUID(),
                              templateId: selectedTemplateEdit.id,
                            });
                        }}
                      >
                        Archive
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
              {selectedTemplateEdit?.status === "archived" && templateIsLatest ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (projectId)
                      void act({
                        type: "template.restore",
                        projectId,
                        commandId: randomUUID(),
                        templateId: selectedTemplateEdit.id,
                      });
                  }}
                >
                  Restore template
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
