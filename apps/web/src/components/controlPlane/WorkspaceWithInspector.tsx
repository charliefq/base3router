import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { OperationalInspectorHost } from "./OperationalInspectorHost";
import { WorkspaceScrollPane } from "./workspaceScrollLayout";

export function WorkspaceWithInspector(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly environmentId?: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
  readonly threadId?: ThreadId | null;
}) {
  return (
    <WorkspaceScrollPane
      className={props.className}
      inspector={
        <OperationalInspectorHost
          environmentId={props.environmentId ?? null}
          projectId={props.projectId ?? null}
          threadId={props.threadId ?? null}
        />
      }
    >
      {props.children}
    </WorkspaceScrollPane>
  );
}
