import type {
  ModelRouterDecision,
  ModelRouterMode,
  OpenRouterGuidanceMode,
} from "@t3tools/contracts";
import { memo } from "react";
import { CircleHelpIcon, RouteIcon } from "lucide-react";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerSelectControl,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import {
  presentModelRouterFallbackLabel,
  presentModelRouterWhy,
} from "../../modelRouterPresentation";

const MODE_LABEL: Record<ModelRouterMode, string> = {
  auto: "Auto Route",
  manual: "Manual",
};

export const ModelRouterControl = memo(function ModelRouterControl(props: {
  readonly mode: ModelRouterMode;
  readonly decision: ModelRouterDecision;
  readonly size?: ComposerControlSize;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly onModeChange: (mode: ModelRouterMode) => void;
  readonly openRouter?: {
    readonly mode: OpenRouterGuidanceMode;
    readonly connectionStatus: "not_configured" | "connected" | "unavailable";
  };
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const why = presentModelRouterWhy(props.decision);
  const fallback = presentModelRouterFallbackLabel(props.decision);
  const selected = props.decision.selected?.target;
  const executed = props.decision.executed?.target;
  const rerouted =
    selected !== undefined &&
    executed !== undefined &&
    (selected.instanceId !== executed.instanceId || selected.model !== executed.model);
  const selectedLabel = selected
    ? rerouted && executed
      ? `Rerouted from ${selected.instanceId} · ${selected.model} to ${executed.instanceId} · ${executed.model}`
      : `${selected.instanceId} · ${selected.model}`
    : "No eligible model";
  const shownModel =
    rerouted && executed && selected
      ? `${selected.model} → ${executed.model}`
      : (selected?.model ?? "Unrouted");

  return (
    <span
      data-model-router-cluster="true"
      className="flex w-max min-w-max shrink-0 items-center gap-1"
    >
      <Tooltip>
        <Select
          open={open}
          onOpenChange={setOpen}
          value={props.mode}
          onValueChange={(value) => {
            if (value === "auto" || value === "manual") props.onModeChange(value);
          }}
          disabled={props.disabled}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                size={size}
                aria-label="Model routing mode"
                data-model-router-mode={props.mode}
              />
            }
          >
            <ComposerControlIcon
              className={props.mode === "auto" ? "text-route-auto" : "text-route-manual"}
              icon={RouteIcon}
              size={size}
            />
            <SelectValue data-composer-control-label>{MODE_LABEL[props.mode]}</SelectValue>
          </TooltipTrigger>
          <SelectPopup align="start" {...composerFloatingLayerProps}>
            <SelectItem value="auto">Auto Route</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">
          {props.mode === "auto"
            ? "Auto Route: Base3Router selects an available, authorized model. No learned routing, classification, or measured cost."
            : "Manual: use the model chosen in the picker. Failover stays off."}
        </TooltipPopup>
      </Tooltip>
      {props.mode === "auto" ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={
                    rerouted
                      ? "max-w-48 truncate text-2xs text-muted-foreground sm:max-w-56"
                      : "max-w-28 truncate text-2xs text-muted-foreground sm:max-w-40"
                  }
                  data-model-router-selected
                  data-model-router-rerouted={rerouted ? "true" : undefined}
                />
              }
            >
              {shownModel}
            </TooltipTrigger>
            <TooltipPopup side="top">{selectedLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <ComposerControl
                  size={size}
                  aria-label="Why this model?"
                  data-model-router-why
                  type="button"
                />
              }
            >
              <ComposerControlIcon icon={CircleHelpIcon} size={size} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <span className="block max-w-64 text-left">
                {why}
                {fallback ? ` ${fallback}.` : ""}
              </span>
            </TooltipPopup>
          </Tooltip>
          {fallback ? (
            <span
              className="hidden text-2xs text-muted-foreground sm:inline"
              data-model-router-fallback
            >
              {fallback}
            </span>
          ) : null}
        </>
      ) : null}
      {props.openRouter !== undefined && props.openRouter.connectionStatus !== "not_configured" ? (
        <span
          className="max-w-28 truncate text-2xs text-muted-foreground"
          data-openrouter-guidance={props.openRouter.mode}
          data-openrouter-connection={props.openRouter.connectionStatus}
          title="OpenRouter guidance is separate from Auto Route"
        >
          OR {props.openRouter.mode}
        </span>
      ) : null}
    </span>
  );
});
