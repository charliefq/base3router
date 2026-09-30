import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SidebarInset } from "../ui/sidebar";
import { OperationalInspectorHost } from "./OperationalInspectorHost";

export function WorkspaceWithInspector(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly environmentId?: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
  readonly threadId?: ThreadId | null;
}) {
  return (
    <SidebarInset
      className={cn("h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh", props.className)}
    >
      <div className="flex h-full min-w-0">
        <div className="min-w-0 flex-1">{props.children}</div>
        <OperationalInspectorHost
          environmentId={props.environmentId ?? null}
          projectId={props.projectId ?? null}
          threadId={props.threadId ?? null}
        />
      </div>
    </SidebarInset>
  );
}
