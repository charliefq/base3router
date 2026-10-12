import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { CollaborationSnapshot, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentConnectionState, useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { collaborationEnvironment } from "../../state/collaboration";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsCollaborationAgentsRouteScreen() {
  return <CollaborationDirectory mode="agents" />;
}
export function SettingsCollaborationTasksRouteScreen() {
  return <CollaborationDirectory mode="tasks" />;
}

function CollaborationDirectory({ mode }: { readonly mode: "agents" | "tasks" }) {
  const { environments } = useEnvironments();
  const available = environments.filter((entry) => entry.connection.phase === "connected");
  const projects = useProjects();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [selection, setSelection] = useState<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
  } | null>(null);
  const environment =
    available.length === 1
      ? available[0]
      : available.find((entry) => entry.environmentId === environmentId);
  const localProjects = projects.filter(
    (project) => project.environmentId === environment?.environmentId,
  );
  const project =
    localProjects.length === 1
      ? localProjects[0]
      : localProjects.find(
          (project) =>
            selection?.environmentId === environment?.environmentId &&
            project.id === selection?.projectId,
        );
  return (
    <SettingsScreen title={mode === "agents" ? "Collaboration agents" : "Collaboration tasks"}>
      <View className="gap-3 p-4">
        <Text>Read-only collaboration records. Opening a known thread does not start work.</Text>
        <SettingsSection title="Environment">
          {available.map((entry) => (
            <Pressable
              key={entry.environmentId}
              accessibilityRole="button"
              accessibilityState={{ selected: environment?.environmentId === entry.environmentId }}
              onPress={() => {
                setEnvironmentId(entry.environmentId);
                setSelection(null);
              }}
            >
              <Text>{entry.label}</Text>
            </Pressable>
          ))}
          {!environment ? <Text>Select a connected environment.</Text> : null}
        </SettingsSection>
        <SettingsSection title="Project">
          {localProjects.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityState={{ selected: project?.id === entry.id }}
              onPress={() =>
                setSelection({ environmentId: entry.environmentId, projectId: entry.id })
              }
            >
              <Text>{entry.title}</Text>
            </Pressable>
          ))}
          {environment && !project ? <Text>Select a project in this environment.</Text> : null}
        </SettingsSection>
        {environment && project ? (
          <ConnectedCollaborationRecords
            key={JSON.stringify([environment.environmentId, project.id])}
            mode={mode}
            environmentId={environment.environmentId}
            projectId={project.id}
          />
        ) : null}
      </View>
    </SettingsScreen>
  );
}

function ConnectedCollaborationRecords(props: Parameters<typeof CollaborationRecords>[0]) {
  const connection = useEnvironmentConnectionState(props.environmentId);
  return connection.data?.phase === "connected" ? (
    <CollaborationRecords key={connection.data.generation} {...props} />
  ) : (
    <Text>Waiting for the selected environment connection.</Text>
  );
}

function CollaborationRecords(props: {
  readonly mode: "agents" | "tasks";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation = useNavigation();
  const registry = useContext(RegistryContext);
  const read = useAtomQueryRunner(collaborationEnvironment.snapshot, { reportFailure: false });
  const threads = useThreadShells();
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef({ generation: 0, pending: false, mounted: false });
  useLayoutEffect(() => {
    request.current.mounted = true;
    return () => {
      request.current.mounted = false;
      request.current.generation++;
    };
  }, []);
  const load = async () => {
    if (request.current.pending) return;
    request.current.pending = true;
    const generation = ++request.current.generation;
    setPending(true);
    setSnapshot(null);
    setError(null);
    try {
      const target = {
        environmentId: props.environmentId,
        input: { environmentId: props.environmentId, projectId: props.projectId },
      };
      registry.refresh(collaborationEnvironment.snapshot(target));
      const result = await read(target);
      if (generation !== request.current.generation) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setSnapshot(result.value);
    } catch (cause) {
      if (generation === request.current.generation)
        setError(cause instanceof Error ? cause.message : "Collaboration records are unavailable.");
    } finally {
      if (generation === request.current.generation) {
        request.current.pending = false;
        setPending(false);
      }
    }
  };
  const agents = snapshot?.agents.filter((agent) => agent.projectId === props.projectId) ?? [];
  const rows =
    props.mode === "agents"
      ? agents.map((agent) => ({
          id: agent.id,
          title: agent.displayName,
          detail: agent.availability,
          threadId: agent.threadId,
          agent,
        }))
      : (snapshot?.tasks.filter((task) => task.projectId === props.projectId) ?? []).map(
          (task) => ({
            id: task.id,
            title: task.title,
            detail: task.waitReason ?? task.state,
            threadId: task.threadId,
            agent: agents.find((agent) => agent.id === task.assigneeAgentId),
          }),
        );
  return (
    <View className="gap-3">
      <Pressable accessibilityRole="button" disabled={pending} onPress={() => void load()}>
        <Text>{pending ? "Loading collaboration…" : "Read / retry collaboration"}</Text>
      </Pressable>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {snapshot && rows.length === 0 ? (
        <Text>No collaboration records in this project.</Text>
      ) : null}
      {rows.map((row) => {
        const thread = threads.find(
          (thread) =>
            thread.id === row.threadId &&
            thread.environmentId === props.environmentId &&
            thread.projectId === props.projectId &&
            thread.archivedAt === null,
        );
        const canOpen =
          !!thread &&
          row.agent?.origin === "internal" &&
          row.agent.threadId === row.threadId &&
          thread.modelSelection.instanceId === row.agent.id;
        return (
          <View key={row.id} className="gap-1">
            <Text>{row.title}</Text>
            <Text>{row.detail}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${row.title}`}
              disabled={!canOpen}
              onPress={() => {
                if (!request.current.mounted || request.current.pending || !canOpen || !thread)
                  return;
                navigation.navigate("Thread", {
                  environmentId: String(props.environmentId),
                  threadId: String(thread.id),
                });
              }}
            >
              <Text>Open existing thread</Text>
            </Pressable>
            {!canOpen ? (
              <Text>
                No matching active thread and provider binding is known in this environment and
                project.
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
