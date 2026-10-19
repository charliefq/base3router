import type {
  WorkflowArtifact,
  WorkflowRevisionSource,
  WorkflowRun,
  WorkflowTemplate,
} from "@t3tools/contracts";

/** Source is an occurrence, never the global latest artifact. */
export function workflowRevisionArtifact(
  run: WorkflowRun,
  template: WorkflowTemplate,
  stageId: string,
  attemptNumber: number,
): WorkflowArtifact | null {
  if (run.status !== "active" || run.currentStageId !== stageId) return null;
  const index = template.stages.findIndex((stage) => stage.id === stageId);
  const stage = template.stages[index];
  const attempt = run.attempts.findLast((entry) => entry.stageId === stageId);
  if (!stage || !attempt || attempt.attempt !== attemptNumber) return null;
  if (stage.type === "agent")
    return attempt.status === "proposed"
      ? (run.artifacts.findLast(
          (a) =>
            a.runId === run.id &&
            a.stageId === stageId &&
            a.attempt === attemptNumber &&
            a.status === "proposed",
        ) ?? null)
      : null;
  const previous = template.stages[index - 1];
  const sourceAttempt = run.attempts.findLast((a) => a.stageId === previous?.id);
  return stage.type === "human_gate" &&
    attempt.status === "pending" &&
    previous?.type === "agent" &&
    sourceAttempt?.status === "accepted"
    ? (run.artifacts.findLast(
        (a) =>
          a.runId === run.id &&
          a.stageId === previous.id &&
          a.attempt === sourceAttempt.attempt &&
          a.status === "accepted",
      ) ?? null)
    : null;
}
export const workflowRevisionSource = (artifact: WorkflowArtifact): WorkflowRevisionSource => ({
  runId: artifact.runId,
  stageId: artifact.stageId,
  attempt: artifact.attempt,
  artifactId: artifact.id,
});
export function workflowArtifactExcerpt(artifact: WorkflowArtifact) {
  const maxChars = 2_000;
  const full = artifact.sections
    .map((section) => `### ${section.label}\n${section.missing ? "Unknown" : section.content}`)
    .join("\n");
  let end = Math.min(full.length, maxChars);
  if (end < full.length && /[\uD800-\uDBFF]/.test(full[end - 1] ?? "")) end--;
  return { text: full.slice(0, end), truncated: full.length > end };
}
