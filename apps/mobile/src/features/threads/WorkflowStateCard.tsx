import type { EnvironmentId, ProjectId, ThreadId, WorkflowCatalog } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowEnvironment } from "../../state/workflow";

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

  const run = catalog?.runs.find((entry) =>
    entry.attempts.some((attempt) => attempt.destinationThreadId === props.threadId),
  );
  if (!run) return null;
  const template = catalog?.templates.find(
    (entry) => entry.id === run.templateId && entry.version === run.templateVersion,
  );
  const current = template?.stages.find((entry) => entry.id === run.currentStageId);
  const artifact =
    run.artifacts.findLast((entry) => entry.stageId === current?.id) ?? run.artifacts.at(-1);
  return (
    <View className="mx-3 mt-2 rounded-2xl border border-composer-border bg-composer-surface px-3 py-2">
      <Text className="text-xs font-t3-bold text-foreground">
        Workflow · {template?.displayName ?? run.templateId} v{run.templateVersion}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {run.status} · {current?.label ?? "Finished"} · Role: {current?.profileId ?? "Human"}
        {current?.profileVersion ? ` v${current.profileVersion}` : ""}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-1">
        {template?.stages.map((stage) => {
          const attempt = run.attempts.findLast((entry) => entry.stageId === stage.id);
          return (
            <Text key={stage.id} className="mr-3 text-xs text-foreground-muted">
              {stage.label}: {attempt?.status ?? "waiting"}
            </Text>
          );
        })}
      </ScrollView>
      {run.attempts.findLast((entry) => entry.destinationThreadId === props.threadId)
        ?.routeBinding ? (
        <Text className="text-xs text-foreground">
          Bound provider/model:{" "}
          {
            run.attempts.findLast((entry) => entry.destinationThreadId === props.threadId)!
              .routeBinding!.target.instanceId
          }{" "}
          ·{" "}
          {
            run.attempts.findLast((entry) => entry.destinationThreadId === props.threadId)!
              .routeBinding!.target.model
          }
        </Text>
      ) : null}
      {artifact ? (
        <View className="mt-1">
          <Text className="text-xs font-t3-bold text-foreground">
            {artifact.status === "accepted" ? "Accepted" : "Proposed"} artifact · {artifact.kind}
          </Text>
          {artifact.missingSections.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Missing: {artifact.missingSections.join(", ")}
            </Text>
          ) : null}
          {artifact.sections.map((section) => (
            <Text key={section.label} className="text-xs text-foreground-muted" numberOfLines={3}>
              {section.label}: {section.content}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
