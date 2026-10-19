import type { TaskInstructionSkillReview, TaskInstructionSkillDelivery } from "@t3tools/contracts";
export function TaskInstructionSkillReadout({
  selection,
  delivery,
}: {
  selection?: TaskInstructionSkillReview | undefined;
  delivery?: TaskInstructionSkillDelivery | undefined;
}) {
  if (!selection && !delivery) return null;
  return (
    <section aria-label="Instruction module provenance" className="space-y-1 text-sm">
      <p>
        Selected instruction module:{" "}
        {selection
          ? `${selection.module.id} v${selection.module.version}`
          : "Unknown (legacy selection evidence unavailable)"}
      </p>
      {selection ? (
        <p>
          Selected body SHA256 {selection.module.contentSha256}; module SHA256{" "}
          {selection.module.moduleSha256}. Review {selection.reviewId}; binding SHA256{" "}
          {selection.bindingSha256}; reviewed {selection.reviewedAt}; expires {selection.expiresAt}.
        </p>
      ) : null}
      <p>
        Native input delivery: {delivery?.status ?? "Unknown / no delivery evidence"}. This is not
        successful completion, factual correctness or task acceptance.
      </p>
      {delivery ? (
        <>
          <p>
            Actual input module {delivery.module.id} v{delivery.module.version}; body SHA256{" "}
            {delivery.module.contentSha256}; input SHA256 {delivery.inputSha256}
          </p>
          <p>
            Run {delivery.runId}; attempt {delivery.attemptId}; message {delivery.messageId}; actual
            model {delivery.modelSelection.instanceId} / {delivery.modelSelection.model}; observed{" "}
            {delivery.observedAt}
          </p>
        </>
      ) : null}
      <p>
        Instruction-only; no tool or permission grant. Advisory capability recommendations remain
        separate.
      </p>
    </section>
  );
}
