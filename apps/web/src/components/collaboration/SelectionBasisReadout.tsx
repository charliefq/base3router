import type { ModelRouterSelectionBasis } from "@t3tools/contracts";

const outcomeText = (basis: ModelRouterSelectionBasis): string => {
  switch (basis.outcome) {
    case "unknown":
      return "Ranking arithmetic was not representable; the detailed selection cause is unknown.";
    case "score":
      return `Higher weighted catalog-estimate score decided the selection (${basis.selectedScore ?? "unrepresentable"} vs ${basis.runnerUpScore ?? "unrepresentable"}).`;
    case "tie":
      return `Equal weighted scores (${basis.selectedScore ?? "unrepresentable"}); tie-break stages used: ${basis.tieBreak.join(" → ")}.`;
    case "single":
      return "Only one eligible candidate remained in the selectable ranking.";
    case "none":
      return "No eligible candidate remained in the selectable ranking.";
    case "manual-accepted":
      return "Manual selection; automatic ranking did not decide the target.";
    case "manual-rejected":
      return "Manual selection rejected by supplied constraints; no target selected.";
    case "manual-missing":
      return "Manual target could not be recorded; no target selected.";
  }
};

export function SelectionBasisReadout({ basis }: { basis: ModelRouterSelectionBasis | undefined }) {
  if (basis === undefined) return <p>Detailed ranking basis not recorded</p>;
  const automatic = !basis.outcome.startsWith("manual-");
  return (
    <section aria-label="Detailed ranking basis" className="space-y-2 text-sm">
      <h4>Detailed ranking basis</h4>
      <p>{outcomeText(basis)}</p>
      {automatic ? (
        <>
          <p>{`Selectable eligible candidates: ${basis.consideredEligibleCount} of ${basis.eligibleCount}. Excluded candidates: ${basis.excludedCount}.`}</p>
          <ul>
            {Object.entries(basis.dimensions).map(([name, dimension]) => (
              <li key={name}>
                {`${name}: ${dimension.participation === "weighted" ? "included with weight" : "not included — " + (dimension.participation === "zero-weight" ? "zero weight" : "incomplete eligible-candidate estimates") + "; weight"} ${dimension.weight}. Estimates ${dimension.complete ? "complete" : "incomplete"} across eligible candidates.`}
              </li>
            ))}
          </ul>
          <p>
            Catalog estimates are not measured quality, verified spend, or a prediction of success.
          </p>
        </>
      ) : null}
    </section>
  );
}
