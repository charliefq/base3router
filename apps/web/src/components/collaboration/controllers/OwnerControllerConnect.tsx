import { useMemo } from "react";
import * as Option from "effect/Option";
import { createControllerManagement } from "@t3tools/client-runtime/controllers/owner";
import type { EnvironmentId } from "@t3tools/contracts";
import { ControllerClientError } from "@t3tools/client-runtime/controllers/client";
import { controllerOwnerCommand } from "../../../state/controllerOwner";
import { useAtomCommand } from "../../../state/use-atom-command";
import { usePreparedConnection } from "../../../state/session";
import { ControllerConnect } from "./ControllerConnect";

export function OwnerControllerConnect(props: {
  environmentId: EnvironmentId | null;
  projects: readonly { id: string; title: string }[];
  onProviderSetup: () => void;
  onClose: () => void;
}) {
  const session = Option.getOrNull(usePreparedConnection(props.environmentId));
  const request = useAtomCommand(controllerOwnerCommand, {
    reportFailure: false,
    reportDefect: false,
  });
  const management = useMemo(() => {
    const environmentId = props.environmentId;
    if (!environmentId || !session || session.environmentId !== environmentId) return undefined;
    return createControllerManagement(environmentId, async (input) => {
      const result = await request({ environmentId, input });
      if (result._tag !== "Success") throw new ControllerClientError("uncertain");
      return result.value;
    });
  }, [props.environmentId, session, request]);
  return <ControllerConnect {...props} {...(management ? { management } : {})} />;
}
