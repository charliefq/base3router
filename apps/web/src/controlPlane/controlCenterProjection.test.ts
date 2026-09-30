import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, type ServerConfig, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  acceptEnvironmentScopedValue,
  capabilitiesFromServerConfig,
  resolveControlCenterEnvironmentId,
  scopeRecordsToEnvironment,
  selectControlCenterSource,
} from "./controlCenterProjection";
import { presentControlCenter, selectControlCenterInspectorTarget } from "./presentControlCenter";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function project(environmentId: EnvironmentId, id: ProjectId, title: string): EnvironmentProject {
  return {
    environmentId,
    id,
    title,
    updatedAt: "2026-09-30T01:00:00.000Z",
  } as EnvironmentProject;
}

function thread(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  id: ThreadId,
  title: string,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId,
    id,
    title,
    updatedAt: "2026-09-30T02:00:00.000Z",
    createdAt: "2026-09-30T00:00:00.000Z",
    hasPendingApprovals: false,
    settledAt: null,
    archivedAt: null,
    session: null,
  } as EnvironmentThreadShell;
}

function serverConfig(
  environmentId: EnvironmentId,
  capabilities: {
    readonly dispatcherRoutePreview?: boolean;
    readonly workflowOs?: boolean;
    readonly cursorCloudRunner?: boolean;
  },
): ServerConfig {
  return {
    environment: {
      environmentId,
      capabilities,
    },
  } as ServerConfig;
}

it("prefers the paired active environment over the catalog primary", () => {
  expect(resolveControlCenterEnvironmentId(envA, envB)).toBe(envA);
  expect(resolveControlCenterEnvironmentId(null, envB)).toBe(envB);
  expect(resolveControlCenterEnvironmentId(null, null)).toBeNull();
});

it("shows the live project and thread for one paired environment", () => {
  const source = selectControlCenterSource({
    activeEnvironmentId: envA,
    primaryEnvironmentId: envA,
    catalogReady: true,
    bootstrapped: true,
    connectionPhase: "connected",
    serverConfig: serverConfig(envA, {
      dispatcherRoutePreview: true,
      workflowOs: true,
      cursorCloudRunner: false,
    }),
    incomingEnvironmentId: envA,
    projects: [project(envA, projectA, "Isolated Alpha Smoke")],
    threads: [thread(envA, projectA, threadA, "Isolated Alpha smoke task")],
  });
  const model = presentControlCenter(source);

  expect(model.surface).toBe("ready");
  expect(model.selectedEnvironmentId).toBe(envA);
  expect(model.projects.map((entry) => entry.id)).toEqual([projectA]);
  expect(model.recentTasks.map((entry) => entry.id)).toEqual([threadA]);
  expect(model.capabilities).toEqual({
    dispatcher: true,
    workflow: true,
    cursorCloud: false,
  });
  expect(model.capabilityOff).toBe(false);
  expect(model.empty).toBe(false);
});

it("keeps a second environment isolated from the selected projection", () => {
  const source = selectControlCenterSource({
    activeEnvironmentId: envA,
    primaryEnvironmentId: envA,
    catalogReady: true,
    bootstrapped: true,
    connectionPhase: "connected",
    serverConfig: serverConfig(envA, { dispatcherRoutePreview: true }),
    incomingEnvironmentId: envA,
    projects: [
      project(envA, projectA, "Paired project"),
      project(envB, projectB, "Other environment project"),
    ],
    threads: [
      thread(envA, projectA, threadA, "Paired thread"),
      thread(envB, projectB, threadB, "Other environment thread"),
    ],
  });
  const model = presentControlCenter(source);

  expect(model.projects.map((entry) => `${entry.environmentId}:${entry.id}`)).toEqual([
    `${envA}:${projectA}`,
  ]);
  expect(model.recentTasks.map((entry) => `${entry.environmentId}:${entry.id}`)).toEqual([
    `${envA}:${threadA}`,
  ]);
});

it("updates the page when the selected environment switches", () => {
  const shared = {
    catalogReady: true,
    bootstrapped: true,
    connectionPhase: "connected" as const,
    projects: [project(envA, projectA, "Environment A"), project(envB, projectB, "Environment B")],
    threads: [
      thread(envA, projectA, threadA, "Thread A"),
      thread(envB, projectB, threadB, "Thread B"),
    ],
  };

  const before = presentControlCenter(
    selectControlCenterSource({
      ...shared,
      activeEnvironmentId: envA,
      primaryEnvironmentId: envA,
      serverConfig: serverConfig(envA, { dispatcherRoutePreview: true }),
      incomingEnvironmentId: envA,
    }),
  );
  const after = presentControlCenter(
    selectControlCenterSource({
      ...shared,
      activeEnvironmentId: envB,
      primaryEnvironmentId: envA,
      serverConfig: serverConfig(envB, { workflowOs: true }),
      incomingEnvironmentId: envB,
    }),
  );

  expect(before.projects[0]?.id).toBe(projectA);
  expect(before.capabilities.dispatcher).toBe(true);
  expect(after.projects[0]?.id).toBe(projectB);
  expect(after.recentTasks[0]?.id).toBe(threadB);
  expect(after.capabilities).toEqual({
    dispatcher: false,
    workflow: true,
    cursorCloud: false,
  });
});

it("restores the same project and thread ids after a restart-shaped reload", () => {
  const input = {
    activeEnvironmentId: envA,
    primaryEnvironmentId: envA,
    catalogReady: true,
    bootstrapped: true,
    connectionPhase: "connected" as const,
    serverConfig: serverConfig(envA, { dispatcherRoutePreview: true, workflowOs: true }),
    incomingEnvironmentId: envA,
    projects: [project(envA, projectA, "Isolated Alpha Smoke")],
    threads: [thread(envA, projectA, threadA, "Isolated Alpha smoke task")],
  };

  const first = presentControlCenter(selectControlCenterSource(input));
  const reloaded = presentControlCenter(selectControlCenterSource(input));

  expect(reloaded.projects.map((entry) => entry.id)).toEqual(
    first.projects.map((entry) => entry.id),
  );
  expect(reloaded.recentTasks.map((entry) => entry.id)).toEqual(
    first.recentTasks.map((entry) => entry.id),
  );
  expect(selectControlCenterInspectorTarget(reloaded)).toEqual({
    environmentId: envA,
    projectId: projectA,
    threadId: threadA,
  });
});

it("shows an unpaired empty state when no environment is selected", () => {
  const model = presentControlCenter(
    selectControlCenterSource({
      activeEnvironmentId: null,
      primaryEnvironmentId: null,
      catalogReady: false,
      bootstrapped: false,
      connectionPhase: null,
      serverConfig: null,
      projects: [project(envA, projectA, "Should not appear")],
      threads: [thread(envA, projectA, threadA, "Should not appear")],
    }),
  );

  expect(model.surface).toBe("unpaired");
  expect(model.empty).toBe(false);
  expect(model.capabilityOff).toBe(false);
  expect(model.projects).toEqual([]);
  expect(model.recentTasks).toEqual([]);
  expect(selectControlCenterInspectorTarget(model)).toEqual({
    environmentId: null,
    projectId: null,
    threadId: null,
  });
});

it("shows offline instead of inventing capability-off when the paired environment is down", () => {
  const model = presentControlCenter(
    selectControlCenterSource({
      activeEnvironmentId: envA,
      primaryEnvironmentId: envA,
      catalogReady: true,
      bootstrapped: false,
      connectionPhase: "offline",
      serverConfig: null,
      incomingEnvironmentId: envA,
      projects: [],
      threads: [],
    }),
  );

  expect(model.surface).toBe("offline");
  expect(model.empty).toBe(false);
  expect(model.capabilityOff).toBe(false);
});

it("does not claim empty while the paired environment is still loading", () => {
  const model = presentControlCenter(
    selectControlCenterSource({
      activeEnvironmentId: envA,
      primaryEnvironmentId: envA,
      catalogReady: true,
      bootstrapped: false,
      connectionPhase: "connecting",
      serverConfig: null,
      incomingEnvironmentId: envA,
      projects: [],
      threads: [],
    }),
  );

  expect(model.surface).toBe("loading");
  expect(model.empty).toBe(false);
  expect(model.capabilityOff).toBe(false);
});

it("drops a stale environment response when the selection has already changed", () => {
  const stale = serverConfig(envA, { dispatcherRoutePreview: true, workflowOs: true });
  const accepted = acceptEnvironmentScopedValue(envB, envA, stale);

  expect(accepted).toBeNull();
  expect(scopeRecordsToEnvironment(envB, [project(envA, projectA, "Stale")])).toEqual([]);

  const model = presentControlCenter(
    selectControlCenterSource({
      activeEnvironmentId: envB,
      primaryEnvironmentId: envB,
      catalogReady: true,
      bootstrapped: true,
      connectionPhase: "connected",
      serverConfig: stale,
      incomingEnvironmentId: envA,
      projects: [project(envA, projectA, "Stale project"), project(envB, projectB, "Current")],
      threads: [thread(envA, projectA, threadA, "Stale thread")],
    }),
  );

  expect(model.capabilities).toEqual({
    dispatcher: false,
    workflow: false,
    cursorCloud: false,
  });
  expect(model.projects.map((entry) => entry.id)).toEqual([projectB]);
  expect(model.recentTasks).toEqual([]);
});

it("reads capability flags only from the paired environment server config", () => {
  expect(
    capabilitiesFromServerConfig(
      serverConfig(envA, {
        dispatcherRoutePreview: true,
        workflowOs: true,
        cursorCloudRunner: false,
      }),
    ),
  ).toEqual({
    dispatcher: true,
    workflow: true,
    cursorCloud: false,
  });
  expect(capabilitiesFromServerConfig(null)).toEqual({
    dispatcher: false,
    workflow: false,
    cursorCloud: false,
  });
});
