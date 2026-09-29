import type {
  AgentProfile,
  WorkflowArtifact,
  WorkflowCatalog,
  WorkflowMutation,
  WorkflowRun,
  WorkflowStage,
  WorkflowTemplate,
} from "@t3tools/contracts";
import {
  WORKFLOW_MAX_ARTIFACT_CHARS,
  WORKFLOW_MAX_RECORDS,
  WorkflowRun as WorkflowRunSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BUILTIN_AGENT_PROFILES, BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";

export const emptyWorkflowCatalog = (): WorkflowCatalog => ({
  profiles: [],
  templates: [],
  runs: [],
});

export class WorkflowPolicyError extends Error {}

const runEquivalent = Schema.toEquivalence(WorkflowRunSchema);

const reject = (message: string): never => {
  throw new WorkflowPolicyError(message);
};

export const availableProfiles = (
  catalog: WorkflowCatalog,
  projectId: string,
): ReadonlyArray<AgentProfile> => [
  ...BUILTIN_AGENT_PROFILES,
  ...catalog.profiles.filter((profile) => profile.projectId === projectId),
];

export const availableTemplates = (
  catalog: WorkflowCatalog,
  projectId: string,
): ReadonlyArray<WorkflowTemplate> => [
  ...BUILTIN_WORKFLOW_TEMPLATES,
  ...catalog.templates.filter((template) => template.projectId === projectId),
];

const latestVersion = <T extends { readonly id: string; readonly version: number }>(
  records: ReadonlyArray<T>,
  id: string,
): T | undefined =>
  records.filter((entry) => entry.id === id).toSorted((a, b) => b.version - a.version)[0];

export const profileVersion = (
  catalog: WorkflowCatalog,
  projectId: string,
  id: string,
  version: number,
): AgentProfile | undefined =>
  availableProfiles(catalog, projectId).find(
    (profile) => profile.id === id && profile.version === version,
  );

export const templateVersion = (
  catalog: WorkflowCatalog,
  projectId: string,
  id: string,
  version: number,
): WorkflowTemplate | undefined =>
  availableTemplates(catalog, projectId).find(
    (template) => template.id === id && template.version === version,
  );

export function validateTemplate(template: WorkflowTemplate, catalog: WorkflowCatalog): void {
  const ids = new Set<string>();
  for (const [index, stage] of template.stages.entries()) {
    // Task templates are untrusted user context, never an executable workflow language.
    if (
      /```|^\s*#!|\b(?:sudo|eval|child_process|execSync)\b/m.test(stage.taskPromptTemplate) ||
      /\bBearer\s+\S+|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,})\b|\b[A-Z][A-Z0-9_]{2,}=\S+/i.test(
        stage.taskPromptTemplate,
      )
    )
      reject(`Stage '${stage.id}' contains executable code or a credential-shaped value.`);
    if (ids.has(stage.id)) reject(`Duplicate workflow stage '${stage.id}'.`);
    ids.add(stage.id);
    if (stage.nextStageId !== (template.stages[index + 1]?.id ?? null))
      reject(`Stage '${stage.id}' must point to the next stage in order.`);
    if (stage.type === "agent") {
      const profileId =
        stage.profileId ?? reject(`Agent stage '${stage.id}' needs an exact profile version.`);
      const profileVersionNumber =
        stage.profileVersion ?? reject(`Agent stage '${stage.id}' needs an exact profile version.`);
      const profile = profileVersion(
        catalog,
        String(template.projectId),
        profileId,
        profileVersionNumber,
      );
      if (!profile || profile.status !== "active")
        reject(`Profile for stage '${stage.id}' is unavailable.`);
    } else if (stage.profileId !== null || stage.profileVersion !== null) {
      reject(`Non-agent stage '${stage.id}' cannot bind a provider role.`);
    }
    if (
      new Set(stage.requiredOutputSections.map((label) => label.toLowerCase())).size !==
      stage.requiredOutputSections.length
    )
      reject(`Stage '${stage.id}' repeats an output section.`);
  }
}

const currentStage = (run: WorkflowRun, template: WorkflowTemplate): WorkflowStage =>
  template.stages.find((stage) => stage.id === run.currentStageId) ??
  reject("Workflow stage is unavailable.");

const currentAttempt = (run: WorkflowRun) =>
  run.attempts.findLast((attempt) => attempt.stageId === run.currentStageId) ??
  reject("Workflow attempt is unavailable.");

const nextAttempt = (
  stage: WorkflowStage,
  attempt: number,
  at: string,
  source: WorkflowRun["attempts"][number] | null,
): WorkflowRun["attempts"][number] => ({
  stageId: stage.id,
  attempt,
  profileId: stage.profileId,
  profileVersion: stage.profileVersion,
  sourceThreadId: source?.destinationThreadId ?? source?.sourceThreadId ?? null,
  sourceMessageId: source?.destinationMessageId ?? source?.sourceMessageId ?? null,
  sourceTurnId: source?.destinationTurnId ?? source?.sourceTurnId ?? null,
  destinationThreadId: null,
  destinationMessageId: null,
  destinationTurnId: null,
  routeBinding: null,
  status: "pending",
  createdAt: at,
});

export function initialWorkflowRun(input: {
  readonly runId: WorkflowRun["id"];
  readonly projectId: WorkflowRun["projectId"];
  readonly template: WorkflowTemplate;
  readonly originThreadId: WorkflowRun["originatingThreadId"];
  readonly originMessageId: WorkflowRun["originatingMessageId"];
  readonly at: string;
}): WorkflowRun {
  const first = input.template.stages[0] ?? reject("Workflow template has no first stage.");
  return {
    id: input.runId,
    projectId: input.projectId,
    templateId: input.template.id,
    templateVersion: input.template.version,
    status: "active",
    currentStageId: first.id,
    originatingThreadId: input.originThreadId,
    originatingMessageId: input.originMessageId,
    attempts: [nextAttempt(first, 1, input.at, null)],
    artifacts: [],
    decisions: [],
    createdAt: input.at,
    updatedAt: input.at,
    endedAt: null,
    pausedAt: null,
  };
}

const validateArtifact = (artifact: WorkflowArtifact, run: WorkflowRun, stage: WorkflowStage) => {
  const attempt = currentAttempt(run);
  if (
    artifact.runId !== run.id ||
    artifact.stageId !== stage.id ||
    artifact.attempt !== attempt.attempt
  )
    reject("Artifact does not belong to the current stage attempt.");
  if (stage.type === "agent") {
    if (
      attempt.status !== "dispatched" ||
      attempt.destinationThreadId === null ||
      artifact.sourceTurnId === null
    )
      reject("Artifact source turn is not the bound stage turn.");
  } else if (artifact.sourceTurnId !== null)
    reject("A non-agent stage cannot claim a provider turn.");
  if (
    artifact.kind !== stage.artifactKind ||
    artifact.profileId !== stage.profileId ||
    artifact.profileVersion !== stage.profileVersion
  )
    reject("Artifact has a different stage or profile binding.");
  if (artifact.status !== "proposed" || artifact.acceptedAt !== null)
    reject("Only a proposed artifact may be recorded.");
  if (
    artifact.sections.length !== stage.requiredOutputSections.length ||
    artifact.sections.some(
      (section, index) => section.label !== stage.requiredOutputSections[index],
    )
  )
    reject("Artifact sections do not match the stage contract.");
  const missing = artifact.sections
    .filter((section) => section.missing)
    .map((section) => section.label);
  if (JSON.stringify(missing) !== JSON.stringify(artifact.missingSections))
    reject("Artifact missing-section list is inconsistent.");
  if (
    artifact.sections.reduce((sum, section) => sum + section.content.length, 0) >
    WORKFLOW_MAX_ARTIFACT_CHARS
  )
    reject("Artifact content exceeds the bound.");
};

export function applyWorkflowMutation(
  catalog: WorkflowCatalog,
  projectId: string,
  mutation: WorkflowMutation,
): WorkflowCatalog {
  switch (mutation.type) {
    case "profile.save": {
      const profile = mutation.profile;
      if (
        profile.origin !== "custom" ||
        profile.projectId !== projectId ||
        profile.status !== "active"
      )
        reject("Only a custom profile in this project can be saved.");
      if (BUILTIN_AGENT_PROFILES.some((entry) => entry.id === profile.id))
        reject("Built-in profile IDs are reserved.");
      const previous = latestVersion(
        catalog.profiles.filter((entry) => entry.projectId === projectId),
        profile.id,
      );
      if (profile.version !== (previous?.version ?? 0) + 1 || previous?.status === "archived")
        reject("Profile version is stale or archived.");
      if (catalog.profiles.length >= WORKFLOW_MAX_RECORDS - BUILTIN_AGENT_PROFILES.length)
        reject("Profile version limit reached.");
      return { ...catalog, profiles: [...catalog.profiles, profile] };
    }
    case "profile.archive": {
      const latest = latestVersion(
        catalog.profiles.filter((profile) => profile.projectId === projectId),
        mutation.profileId,
      );
      if (!latest || latest.status !== "active") reject("Active custom profile was not found.");
      return {
        ...catalog,
        profiles: catalog.profiles.map((profile) =>
          profile === latest ? { ...profile, status: "archived", updatedAt: mutation.at } : profile,
        ),
      };
    }
    case "profile.restore": {
      const latest = latestVersion(
        catalog.profiles.filter((profile) => profile.projectId === projectId),
        mutation.profileId,
      );
      if (!latest || latest.status !== "archived") reject("Archived custom profile was not found.");
      return {
        ...catalog,
        profiles: catalog.profiles.map((profile) =>
          profile === latest ? { ...profile, status: "active", updatedAt: mutation.at } : profile,
        ),
      };
    }
    case "template.save": {
      const template = mutation.template;
      if (
        template.origin !== "custom" ||
        template.projectId !== projectId ||
        template.status !== "active"
      )
        reject("Only a custom template in this project can be saved.");
      if (BUILTIN_WORKFLOW_TEMPLATES.some((entry) => entry.id === template.id))
        reject("Built-in template IDs are reserved.");
      const previous = latestVersion(
        catalog.templates.filter((entry) => entry.projectId === projectId),
        template.id,
      );
      if (template.version !== (previous?.version ?? 0) + 1 || previous?.status === "archived")
        reject("Template version is stale or archived.");
      validateTemplate(template, catalog);
      if (catalog.templates.length >= WORKFLOW_MAX_RECORDS - BUILTIN_WORKFLOW_TEMPLATES.length)
        reject("Template version limit reached.");
      return { ...catalog, templates: [...catalog.templates, template] };
    }
    case "template.archive": {
      const latest = latestVersion(
        catalog.templates.filter((template) => template.projectId === projectId),
        mutation.templateId,
      );
      if (!latest || latest.status !== "active") reject("Active custom template was not found.");
      return {
        ...catalog,
        templates: catalog.templates.map((template) =>
          template === latest
            ? { ...template, status: "archived", updatedAt: mutation.at }
            : template,
        ),
      };
    }
    case "template.restore": {
      const latest =
        latestVersion(
          catalog.templates.filter((template) => template.projectId === projectId),
          mutation.templateId,
        ) ?? reject("Archived custom template was not found.");
      if (latest.status !== "archived") reject("Archived custom template was not found.");
      validateTemplate({ ...latest, status: "active" }, catalog);
      return {
        ...catalog,
        templates: catalog.templates.map((template) =>
          template === latest
            ? { ...template, status: "active", updatedAt: mutation.at }
            : template,
        ),
      };
    }
    case "run.start": {
      const run = mutation.run;
      if (run.projectId !== projectId || catalog.runs.some((entry) => entry.id === run.id))
        reject("Workflow run ID is already used or belongs to another project.");
      const template =
        templateVersion(catalog, projectId, run.templateId, run.templateVersion) ??
        reject("Workflow template version is unavailable.");
      if (template.status !== "active") reject("Workflow template version is unavailable.");
      validateTemplate(template, catalog);
      const expected = initialWorkflowRun({
        runId: run.id,
        projectId: run.projectId,
        template,
        originThreadId: run.originatingThreadId,
        originMessageId: run.originatingMessageId,
        at: run.createdAt,
      });
      if (!runEquivalent(run, expected))
        reject("Workflow run does not match its immutable template version.");
      if (catalog.runs.length >= WORKFLOW_MAX_RECORDS) reject("Workflow run limit reached.");
      return { ...catalog, runs: [...catalog.runs, run] };
    }
    case "stage.dispatch": {
      const run =
        catalog.runs.find(
          (entry) => entry.id === mutation.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "active" || run.currentStageId !== mutation.stageId)
        reject("Stage is no longer current.");
      const template =
        templateVersion(catalog, projectId, run.templateId, run.templateVersion) ??
        reject("Template version was not found.");
      if (currentStage(run, template).type !== "agent")
        reject("Only an agent stage can dispatch a provider task.");
      const attempt = currentAttempt(run);
      if (attempt.attempt !== mutation.attempt || attempt.status !== "pending")
        reject("Stage has already been dispatched or revised.");
      if (mutation.routeBinding.gate.decision !== "ALLOW")
        reject("The bound provider route was denied.");
      const updated: WorkflowRun = {
        ...run,
        updatedAt: mutation.at,
        attempts: run.attempts.map((entry) =>
          entry === attempt
            ? {
                ...entry,
                status: "dispatched",
                destinationThreadId: mutation.threadId,
                destinationMessageId: mutation.messageId,
                routeBinding: mutation.routeBinding,
                ...(mutation.runnerBinding === undefined
                  ? {}
                  : { runnerBinding: mutation.runnerBinding }),
              }
            : entry,
        ),
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "runner.update": {
      const run =
        catalog.runs.find(
          (entry) => entry.id === mutation.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      const attempt =
        run.attempts.find(
          (entry) => entry.stageId === mutation.stageId && entry.attempt === mutation.attempt,
        ) ?? reject("Workflow attempt is unavailable.");
      if (mutation.runnerBinding.runnerKind !== "cursor-cloud")
        reject("Only a cursor-cloud runner binding can be stored.");
      if (
        mutation.runnerBinding.credentialRef.kind !== "env" ||
        mutation.runnerBinding.credentialRef.name !== "CURSOR_API_KEY"
      )
        reject("Only a credential reference may be persisted.");
      const updated: WorkflowRun = {
        ...run,
        updatedAt: mutation.at,
        attempts: run.attempts.map((entry) =>
          entry === attempt ? { ...entry, runnerBinding: mutation.runnerBinding } : entry,
        ),
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "artifact.propose": {
      const artifact = mutation.artifact;
      const run =
        catalog.runs.find(
          (entry) => entry.id === artifact.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "active" || run.currentStageId !== artifact.stageId)
        reject("Stage is no longer current.");
      const template =
        templateVersion(catalog, projectId, run.templateId, run.templateVersion) ??
        reject("Template version was not found.");
      validateArtifact(artifact, run, currentStage(run, template));
      if (
        run.artifacts.some(
          (entry) =>
            entry.id === artifact.id ||
            (entry.stageId === artifact.stageId && entry.attempt === artifact.attempt),
        )
      )
        reject("Artifact already exists for this attempt.");
      const attempt = currentAttempt(run);
      const updated: WorkflowRun = {
        ...run,
        updatedAt: artifact.createdAt,
        artifacts: [...run.artifacts, artifact],
        attempts: run.attempts.map((entry) =>
          entry === attempt
            ? { ...entry, status: "proposed", destinationTurnId: artifact.sourceTurnId }
            : entry,
        ),
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "decision.record": {
      const decision = mutation.decision;
      const run =
        catalog.runs.find(
          (entry) => entry.id === decision.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "active" || run.currentStageId !== decision.stageId)
        reject("Decision is stale.");
      const template =
        templateVersion(catalog, projectId, run.templateId, run.templateVersion) ??
        reject("Template version was not found.");
      const stage = currentStage(run, template);
      const attempt = currentAttempt(run);
      if (
        decision.attempt !== attempt.attempt ||
        run.decisions.some(
          (entry) =>
            entry.id === decision.id ||
            (entry.stageId === decision.stageId && entry.attempt === decision.attempt),
        )
      )
        reject("Decision is stale or duplicated.");
      const artifact = run.artifacts.find(
        (entry) =>
          entry.id === decision.artifactId &&
          entry.stageId === stage.id &&
          entry.attempt === attempt.attempt,
      );
      if (
        stage.type === "agent" &&
        (!artifact || artifact.status !== "proposed" || attempt.status !== "proposed")
      )
        reject("Review the current proposed artifact first.");
      if (stage.type !== "agent" && decision.artifactId !== null)
        reject("A human gate cannot claim a provider artifact.");
      if (stage.type === "human_gate" && attempt.status !== "pending")
        reject("Human gate has already been decided.");
      if (decision.value === "request_revision") {
        const target =
          (stage.type === "human_gate"
            ? template.stages[template.stages.findIndex((entry) => entry.id === stage.id) - 1]
            : stage) ?? reject("There is no preceding stage to revise.");
        const previous = run.attempts.findLast((entry) => entry.stageId === target.id);
        const number = (previous?.attempt ?? 0) + 1;
        if (number > target.maxAttempts) reject("The stage attempt limit has been reached.");
        const updated: WorkflowRun = {
          ...run,
          currentStageId: target.id,
          updatedAt: decision.createdAt,
          decisions: [...run.decisions, decision],
          attempts: [
            ...run.attempts,
            nextAttempt(target, number, decision.createdAt, previous ?? null),
          ],
        };
        return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
      }
      const next =
        decision.value === "approve"
          ? template.stages.find((entry) => entry.id === stage.nextStageId)
          : undefined;
      const updated: WorkflowRun = {
        ...run,
        status: decision.value === "reject" ? "rejected" : next ? "active" : "completed",
        currentStageId: decision.value === "reject" || !next ? null : next.id,
        updatedAt: decision.createdAt,
        endedAt: decision.value === "reject" || !next ? decision.createdAt : null,
        decisions: [...run.decisions, decision],
        artifacts: run.artifacts.map((entry) =>
          entry === artifact && decision.value === "approve"
            ? { ...entry, status: "accepted", acceptedAt: decision.createdAt }
            : entry,
        ),
        attempts: [
          ...run.attempts.map((entry) =>
            entry === attempt
              ? ({
                  ...entry,
                  status: decision.value === "reject" ? "rejected" : "accepted",
                } as typeof entry)
              : entry,
          ),
          ...(next ? [nextAttempt(next, 1, decision.createdAt, attempt)] : []),
        ],
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "run.cancel": {
      const run =
        catalog.runs.find(
          (entry) => entry.id === mutation.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "active" && run.status !== "paused")
        reject("Only an active or paused workflow can be cancelled.");
      const updated: WorkflowRun = {
        ...run,
        status: "cancelled",
        currentStageId: null,
        updatedAt: mutation.at,
        endedAt: mutation.at,
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "run.pause": {
      const run =
        catalog.runs.find(
          (entry) => entry.id === mutation.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "active") reject("Only an active workflow can be paused.");
      const updated: WorkflowRun = {
        ...run,
        status: "paused",
        pausedAt: mutation.at,
        updatedAt: mutation.at,
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
    case "run.resume": {
      const run =
        catalog.runs.find(
          (entry) => entry.id === mutation.runId && entry.projectId === projectId,
        ) ?? reject("Workflow run was not found.");
      if (run.status !== "paused") reject("Only a paused workflow can be resumed.");
      const updated: WorkflowRun = {
        ...run,
        status: "active",
        pausedAt: null,
        updatedAt: mutation.at,
      };
      return { ...catalog, runs: catalog.runs.map((entry) => (entry === run ? updated : entry)) };
    }
  }
}
