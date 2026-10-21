import { useState } from "react";
import type { CollaborationScopeSearch } from "./collaborationScope";
export interface CollaborationScopeProps {
  scope?: CollaborationScopeSearch;
  onScopeChange?: (scope: CollaborationScopeSearch) => void;
}
export function useCollaborationScope(
  environmentId: string | null | undefined,
  props: CollaborationScopeProps,
) {
  const [initialEnvironment] = useState(environmentId);
  const routeKey = JSON.stringify(props.scope ?? null);
  const [entry, setEntry] = useState(() => ({
    key: routeKey,
    value:
      props.scope ??
      ((environmentId ? { scopeEnvironmentId: environmentId } : {}) as CollaborationScopeSearch),
  }));
  const current = entry.key === routeKey ? entry.value : (props.scope ?? entry.value);
  if (entry.key !== routeKey) setEntry({ key: routeKey, value: current });
  const effective = {
    ...current,
    ...(current.scopeEnvironmentId || !initialEnvironment
      ? {}
      : { scopeEnvironmentId: initialEnvironment }),
  };
  const update = (next: CollaborationScopeSearch) => {
    // Keep an immediate selection for same-frame setup clicks; incoming history
    // searches replace it, so Back/Forward and newer navigation stay authoritative.
    setEntry({ key: routeKey, value: next });
    props.onScopeChange?.(next);
  };
  const canSelect =
    !effective.scopeInvalid &&
    (!effective.scopeEnvironmentId || effective.scopeEnvironmentId === environmentId);
  return {
    scope: effective,
    update,
    selectProject: (id: string | null) => {
      if (canSelect)
        update({
          ...effective,
          ...(environmentId ? { scopeEnvironmentId: environmentId } : {}),
          scopeProjectId: id || undefined,
        });
    },
    selectProvider: (id: string | null) => {
      if (canSelect)
        update({
          ...effective,
          ...(environmentId ? { scopeEnvironmentId: environmentId } : {}),
          scopeProviderId: id || undefined,
        });
    },
  };
}
