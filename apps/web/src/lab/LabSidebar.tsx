import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import {
  LAB_LONG_SIDEBAR_THREADS,
  LAB_SIDEBAR_THREADS,
  type LabScenarioState,
  type UiLabScenarioId,
} from "./scenarios";

export function LabSidebar(props: {
  readonly scenario: LabScenarioState;
  readonly scenarios: ReadonlyArray<LabScenarioState>;
  readonly onScenarioChange: (id: UiLabScenarioId) => void;
}) {
  return (
    <Sidebar collapsible="none" data-ui-lab="sidebar">
      <SidebarHeader>
        <div className="border-b border-border/80">
          <p className="px-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            UI Lab
          </p>
          <label className="px-1 text-xs text-muted-foreground">
            Scenario
            <select
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              data-ui-lab-scenario-select
              value={props.scenario.id}
              onChange={(event) => {
                props.onScenarioChange(event.target.value as UiLabScenarioId);
              }}
            >
              {props.scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>
          <p className="px-1 text-2xs text-muted-foreground">{props.scenario.description}</p>
        </div>
      </SidebarHeader>
      <SidebarContent
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        data-workspace-scroll-surface="sidebar"
      >
        <SidebarGroup>
          <SidebarMenu>
            {(props.scenario.longNames ? LAB_LONG_SIDEBAR_THREADS : LAB_SIDEBAR_THREADS).map(
              (thread, index) => (
                <SidebarMenuItem key={thread.id}>
                  <SidebarMenuButton isActive={index === 0}>
                    <span className="truncate">{thread.text}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ),
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
