import type { EnvironmentId, ProjectId, ThreadId, WorkflowCatalog } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowEnvironment } from "../../state/workflow";
import { presentMobileWorkflowState } from "./presentWorkflowState";

/** Read-only native view. Workflow mutations remain in the shared web/desktop surface. */
export function WorkflowStateCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null);
  const readCatalog = useAtomCommand(workflowEnvironment.catalog, { reportFailure: false });
  useEffect(() => {
    let live = true;
    void readCatalog({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }).then((result) => {
      if (live && result._tag === "Success") setCatalog(result.value);
    });
    return () => {
      live = false;
    };
  }, [props.environmentId, props.projectId, readCatalog]);

  const presented = presentMobileWorkflowState({ catalog, threadId: props.threadId });
  if (!presented) return null;
  return (
    <View className="mx-3 mt-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-2">
      <Text className="text-xs font-t3-bold text-foreground">
        Workflow · {presented.title} v{presented.templateVersion}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {presented.status} · {presented.currentStage} · Read-only · {presented.runnerKind}
        {presented.cancelled ? " · Cancelled" : ""}
        {presented.error ? " · Error" : ""}
        {presented.terminal && !presented.cancelled && !presented.error ? " · Finished" : ""}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-1">
        {presented.stages.map((stage) => (
          <Text key={stage.id} className="mr-3 text-xs text-foreground-muted">
            {stage.label}: {stage.status}
          </Text>
        ))}
      </ScrollView>
      {presented.boundRoute ? (
        <Text className="text-xs text-foreground">
          Bound provider/model: {presented.boundRoute}
        </Text>
      ) : null}
      {presented.cursorCloudStatus ? (
        <Text className="text-xs text-foreground">
          Cursor Cloud · {presented.cursorCloudStatus}
          {presented.agentId ? ` · agent ${presented.agentId}` : ""}
          {presented.runId ? ` · run ${presented.runId}` : ""}
        </Text>
      ) : null}
      {presented.artifact ? (
        <View className="mt-1">
          <Text className="text-xs font-t3-bold text-foreground">
            {presented.artifact.status === "accepted" ? "Accepted" : "Proposed"} artifact ·{" "}
            {presented.artifact.kind}
          </Text>
          {presented.artifact.missingSections.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Missing: {presented.artifact.missingSections.join(", ")}
            </Text>
          ) : null}
          {presented.artifact.sections.map((section) => (
            <Text key={section.label} className="text-xs text-foreground-muted" numberOfLines={3}>
              {section.label}: {section.content}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
