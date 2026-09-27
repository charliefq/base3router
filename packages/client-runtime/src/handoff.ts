import type {
  DispatcherRouteTarget,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

export interface DispatcherHandoffTargetOption {
  readonly target: DispatcherRouteTarget;
  readonly driver: ProviderDriverKind;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

function providerUnavailableReason(provider: ServerProvider): string | null {
  if (provider.availability === "unavailable") return "Runner unavailable";
  if (!provider.enabled || provider.status === "disabled") return "Runner disabled";
  if (!provider.installed) return "Runner not installed";
  if (provider.auth.status === "unauthenticated") return "Sign-in required";
  if (provider.status === "error") return "Runner error";
  return null;
}

/** Options reflect server runner snapshots; a model name alone never makes a provider usable. */
export function dispatcherHandoffTargetOptions(
  providers: ReadonlyArray<ServerProvider>,
  sourceInstanceId: ProviderInstanceId,
): ReadonlyArray<DispatcherHandoffTargetOption> {
  return providers
    .filter((provider) => provider.instanceId !== sourceInstanceId)
    .flatMap((provider) => {
      const providerReason = providerUnavailableReason(provider);
      return provider.models.map((model) => ({
        target: { instanceId: provider.instanceId, model: model.slug },
        driver: provider.driver,
        providerLabel: provider.displayName ?? provider.driver,
        modelLabel: model.name ?? model.slug,
        available: providerReason === null,
        unavailableReason: providerReason,
      }));
    })
    .sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1;
      return (
        left.providerLabel.localeCompare(right.providerLabel) ||
        left.modelLabel.localeCompare(right.modelLabel) ||
        left.target.instanceId.localeCompare(right.target.instanceId)
      );
    });
}
