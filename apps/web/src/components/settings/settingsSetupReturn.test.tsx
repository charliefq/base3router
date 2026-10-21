import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { validateCollaborationScope } from "../collaboration/collaborationScope";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

const fixture = vi.hoisted(() => ({
  scope: {
    kind: "unavailable",
    message: "The selected environment is no longer available.",
    label: "Original environment",
  },
  providerPanel: vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  SettingsScopeProvider: ({ children }: { children: ReactNode }) => children,
  useSettingsScope: () => ({
    scope: fixture.scope,
    search: { machine: "original-environment" },
    connectedEnvironments: [],
    environment: null,
  }),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("./SettingsBreadcrumb", () => ({ SettingsBreadcrumb: () => <span>Settings</span> }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../sidebar/mainAppLocation", () => ({ useNavigateToMainApp: () => () => {} }));
vi.mock("../../hooks/useNavigateBack", () => ({ useEscapeToGoBack: () => {} }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("./SettingsPanels", () => ({
  useSettingsRestore: () => ({ changedSettingLabels: [], restoreDefaults: vi.fn() }),
}));
vi.mock("./SettingsScopeNotice", () => ({
  SettingsScopeNotice: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./ProviderSettingsPanel", () => ({
  ProviderSettingsPanel: () => {
    fixture.providerPanel();
    return <div>Provider panel</div>;
  },
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

import { Route as SettingsRoute } from "../../routes/settings";
import { Route as ProvidersRoute } from "../../routes/settings.providers";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.providerPanel.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each(["unavailable", "environment"] as const)(
  "keeps explicit return outside the production boundary for %s scope",
  async (kind) => {
    fixture.scope = { ...fixture.scope, kind };
    const root = createRootRoute();
    // Use the actual production layout, boundary and provider-route component.
    // Only chrome and the already-resolved environment inventory are fixtures.
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings",
      validateSearch: validateSettingsRouteSearch,
      search: { middlewares: [retainSettingsScope] },
      component: SettingsRoute.options.component!,
    });
    const providers = createRoute({
      getParentRoute: () => settings,
      path: "providers",
      component: ProvidersRoute.options.component!,
    });
    const tasks = createRoute({
      getParentRoute: () => root,
      path: "tasks",
      validateSearch: validateCollaborationScope,
      component: () => <div>Tasks destination</div>,
    });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([providers]), tasks]),
      history: createMemoryHistory({
        initialEntries: [
          "/settings/providers?machine=original-environment&returnPage=tasks&scopeEnvironmentId=original-environment&scopeProjectId=original-project&scopeProviderId=original-provider",
        ],
      }),
    });
    await act(async () => {
      await router.load();
      renderer = create(<RouterProvider router={router} />);
    });
    const content = JSON.stringify(renderer!.toJSON());
    expect(content).toContain(
      kind === "unavailable" ? "selected environment is no longer available" : "Reconnect",
    );
    expect(fixture.providerPanel).not.toHaveBeenCalled();
    const button = renderer!.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "Return to Tasks");
    expect(button).toBeDefined();
    await act(async () => button!.props.onClick());
    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({
      scopeEnvironmentId: "original-environment",
      scopeProjectId: "original-project",
      scopeProviderId: "original-provider",
    });
    expect(fixture.providerPanel).not.toHaveBeenCalled();
  },
);
