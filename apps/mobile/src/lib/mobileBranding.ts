export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}

/** Display-only mapping. Variant/IPC stage stays Alpha | Dev | Nightly. */
export function visibleMobileStageLabel(stageLabel: string): string {
  return stageLabel === "Alpha" ? "Internal Alpha" : stageLabel;
}
