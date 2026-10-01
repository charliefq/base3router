import { useMemo, useState } from "react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ModelRouterMode } from "@t3tools/contracts";

import { SidebarProvider } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { labDecision } from "./fixtures";
import { simulateRoutedTurn } from "./fakeProvider";
import { LabWorkspace } from "./LabWorkspace";
import {
  UI_LAB_SCENARIOS,
  createLabScenario,
  isUiLabScenarioId,
  type LabScenarioState,
  type UiLabScenarioId,
} from "./scenarios";

function readScenarioId(): UiLabScenarioId {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("scenario");
  return isUiLabScenarioId(requested) ? requested : "empty-thread";
}

function writeScenarioId(id: UiLabScenarioId): void {
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", id);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function LabShell() {
  const [scenarioId, setScenarioId] = useState<UiLabScenarioId>(readScenarioId);
  const [scenario, setScenario] = useState<LabScenarioState>(() => createLabScenario(scenarioId));
  const [mode, setMode] = useState<ModelRouterMode>(scenario.mode);
  const [decision, setDecision] = useState(scenario.decision);
  const [messages, setMessages] = useState(scenario.messages);
  const [prompt, setPrompt] = useState(scenario.prompt);
  const [error, setError] = useState(scenario.error);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(scenario.inspectorCollapsed);

  const applyScenario = (id: UiLabScenarioId) => {
    const next = createLabScenario(id);
    setScenarioId(id);
    setScenario(next);
    setMode(next.mode);
    setDecision(next.decision);
    setMessages(next.messages);
    setPrompt(next.prompt);
    setError(next.error);
    setInspectorCollapsed(next.inspectorCollapsed);
    writeScenarioId(id);
  };

  return (
    <div
      className="flex h-svh min-h-0 w-full overflow-hidden bg-background text-foreground"
      data-ui-lab="root"
      data-ui-lab-scenario={scenario.id}
      data-ui-lab-viewport={scenario.viewport}
    >
      <LabWorkspace
        decision={decision}
        error={error}
        inspectorCollapsed={inspectorCollapsed}
        messages={messages}
        mode={mode}
        prompt={prompt}
        scenario={scenario}
        scenarios={UI_LAB_SCENARIOS}
        onDismissError={() => setError(null)}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          setDecision(
            labDecision({
              mode: nextMode,
              selected: decision.selected,
              fallbacks: decision.fallbacks,
              candidates: decision.candidates,
              ...(decision.executed === undefined ? {} : { executed: decision.executed }),
              executionStatus: decision.executionStatus,
              attempts: decision.attempts,
              explanation:
                nextMode === "manual"
                  ? "Manual selection kept the current model."
                  : decision.explanation,
            }),
          );
        }}
        onPromptChange={setPrompt}
        onScenarioChange={applyScenario}
        onSubmit={() => {
          const text = prompt.trim();
          if (text.length === 0) return;
          const result = simulateRoutedTurn({
            decision: { ...decision, mode },
            adapters: scenario.adapters,
            prompt: text,
          });
          setDecision(result.decision);
          setError(result.error);
          setMessages((current) => [
            ...current,
            { id: `lab-user-${current.length + 1}`, role: "user", text },
            ...(result.assistantText
              ? [
                  {
                    id: `lab-assistant-${current.length + 1}`,
                    role: "assistant" as const,
                    text: result.assistantText,
                  },
                ]
              : []),
          ]);
          setPrompt("");
          setScenario((current) => ({
            ...current,
            threadStatus: result.status === "completed" ? "completed" : "failed",
            decision: result.decision,
            error: result.error,
          }));
        }}
        onToggleInspector={() => setInspectorCollapsed((current) => !current)}
      />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  validateSearch: (search: Record<string, unknown>) => ({
    section:
      search.section === "workflows" || search.section === "agents" ? search.section : undefined,
  }),
});

const labRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LabShell,
});

const controlCenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/control-center",
  component: LabShell,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: LabShell,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$environmentId/$threadId",
  component: LabShell,
});

const routeTree = rootRoute.addChildren([labRoute, controlCenterRoute, settingsRoute, threadRoute]);

export function LabApp() {
  const router = useMemo(
    () =>
      createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: ["/"] }),
      }),
    [],
  );

  return (
    <TooltipProvider delay={0}>
      <SidebarProvider className="h-svh min-h-0" defaultOpen>
        <RouterProvider router={router as never} />
      </SidebarProvider>
    </TooltipProvider>
  );
}
