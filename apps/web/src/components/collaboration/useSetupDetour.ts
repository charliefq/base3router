import { useLayoutEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  validateCollaborationScope,
  type CollaborationPage,
  type CollaborationScopeSearch,
} from "./collaborationScope";
export function useSetupDetour(
  page: CollaborationPage,
  scope: CollaborationScopeSearch,
  environmentId: EnvironmentId | null,
  projectId?: string,
  providerId?: string,
) {
  const navigate = useNavigate();
  const owner = useRef<"idle" | "pending" | "gone">("idle");
  useLayoutEffect(() => {
    owner.current = "idle";
    return () => {
      owner.current = "gone";
    };
  }, []);
  const target = validateCollaborationScope({
    ...scope,
    scopeEnvironmentId: scope.scopeEnvironmentId ?? environmentId ?? undefined,
    scopeProjectId: scope.scopeProjectId ?? projectId,
    scopeProviderId: scope.scopeProviderId ?? providerId,
  });
  const latest = useRef<typeof target | null>(null);
  useLayoutEffect(() => {
    latest.current = target;
  });
  return () => {
    if (owner.current !== "idle" || latest.current !== target) return;
    owner.current = "pending";
    return Promise.resolve(
      navigate({
        to: "/settings/providers",
        search: {
          returnPage: page,
          ...target,
          ...(target.scopeEnvironmentId
            ? { environmentId: EnvironmentId.make(target.scopeEnvironmentId) }
            : {}),
          ...(target.scopeProviderId
            ? { instanceId: ProviderInstanceId.make(target.scopeProviderId) }
            : {}),
        },
      }),
    ).finally(() => {
      if (owner.current !== "gone") owner.current = "idle";
    });
  };
}
