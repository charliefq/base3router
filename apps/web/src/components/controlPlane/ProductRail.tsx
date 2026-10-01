import { Link } from "@tanstack/react-router";
import {
  FolderIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  SettingsIcon,
  WaypointsIcon,
  WorkflowIcon,
} from "lucide-react";

import { APP_BASE_NAME, APP_STAGE_LABEL } from "~/branding";
import {
  productSectionLabel,
  productSectionTarget,
  resolveProductSection,
  type ProductSection,
} from "~/controlPlane/productNavigation";
import { cn } from "~/lib/utils";
import { Base3RouterMark } from "../Base3RouterMark";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SECTION_ICON: Record<ProductSection, typeof LayoutDashboardIcon> = {
  "control-center": LayoutDashboardIcon,
  projects: FolderIcon,
  tasks: MessageSquareIcon,
  workflows: WorkflowIcon,
  agents: WaypointsIcon,
  settings: SettingsIcon,
};

const RAIL_SECTIONS: ReadonlyArray<ProductSection> = [
  "control-center",
  "projects",
  "tasks",
  "workflows",
  "agents",
  "settings",
];

export function ProductRail(props: {
  readonly pathname: string;
  readonly searchSection?: string | null;
}) {
  const active = resolveProductSection({
    pathname: props.pathname,
    searchSection: props.searchSection ?? null,
  });

  return (
    <nav
      aria-label="Base3Router"
      className="hidden h-full w-(--control-plane-rail-width) shrink-0 flex-col border-r border-border/80 bg-(--control-plane-rail-background) md:flex"
      data-control-plane="rail"
    >
      <div className="flex h-(--workspace-topbar-height) items-center justify-center">
        <Link
          aria-label={`${APP_BASE_NAME} Control Center`}
          className="flex size-8 items-center justify-center rounded-md text-info-foreground outline-hidden ring-ring focus-visible:ring-2"
          to="/control-center"
        >
          <Base3RouterMark className="size-5" />
        </Link>
      </div>
      <div className="flex flex-1 flex-col items-center gap-1 px-1.5 py-2">
        {RAIL_SECTIONS.map((section) => {
          const Icon = SECTION_ICON[section];
          const target = productSectionTarget(section);
          const selected = active === section;
          const className = cn(
            "flex size-9 items-center justify-center rounded-md text-muted-foreground outline-hidden ring-(--control-plane-focus-ring) hover:bg-muted/60 hover:text-foreground focus-visible:ring-2",
            selected && "bg-muted text-foreground",
          );
          const link = target.search ? (
            <Link
              aria-current={selected ? "page" : undefined}
              aria-label={productSectionLabel(section)}
              className={className}
              search={target.search}
              to={target.to}
            >
              <Icon className="size-4" />
            </Link>
          ) : (
            <Link
              aria-current={selected ? "page" : undefined}
              aria-label={productSectionLabel(section)}
              className={className}
              to={target.to}
            >
              <Icon className="size-4" />
            </Link>
          );
          return (
            <Tooltip key={section}>
              <TooltipTrigger render={link} />
              <TooltipPopup side="right">{productSectionLabel(section)}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <p className="px-1 pb-3 text-center text-3xs tracking-widest text-muted-foreground uppercase">
        {APP_STAGE_LABEL}
      </p>
    </nav>
  );
}
