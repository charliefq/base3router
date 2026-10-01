import {
  DEFAULT_OPENROUTER_GUIDANCE_SETTINGS,
  type OpenRouterCostTier,
  type OpenRouterGuidanceMode,
} from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { usePrimaryEnvironment } from "../../state/environments";

const MODE_LABEL: Record<OpenRouterGuidanceMode, string> = {
  off: "Off",
  shadow: "Shadow",
  teacher: "Teacher",
};

const COST_LABEL: Record<OpenRouterCostTier, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function OpenRouterGuidanceSettings() {
  const settings = useScopedSettings((value) => value.openRouter);
  const updateSettings = useUpdateScopedSettings();
  const environment = usePrimaryEnvironment();
  const capability = environment?.serverConfig?.environment.capabilities.openRouterGuidance;
  if (capability === undefined) return null;

  const guidance = settings ?? DEFAULT_OPENROUTER_GUIDANCE_SETTINGS;
  const connected = capability.connectionStatus === "connected";

  return (
    <SettingsSection id="openrouter-guidance" title="OpenRouter guidance">
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        {...searchableSetting("openrouter-guidance")}
        description="OpenRouter Auto is an external teacher. It does not replace Base3Router Auto Route, Manual selection, or Access Auto. Off keeps Phase 8 routing unchanged."
        control={
          <p
            className="text-2xs text-muted-foreground"
            data-openrouter-connection={capability.connectionStatus}
          >
            {connected ? "Connected" : "Unavailable until OPENROUTER_API_KEY is set on the server."}
          </p>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        title="Guidance mode"
        description="Off sends nothing. Shadow observes without changing the turn. Teacher executes OpenRouter Auto inside the eligible set."
        control={
          <Select
            value={guidance.guidanceMode}
            onValueChange={(value) => {
              if (value === "off" || value === "shadow" || value === "teacher") {
                updateSettings({
                  openRouter: {
                    ...guidance,
                    guidanceMode: value,
                    ...(value === "shadow" ? {} : {}),
                  },
                });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label="OpenRouter guidance mode"
            >
              <SelectValue>{MODE_LABEL[guidance.guidanceMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="off">
                Off
              </SelectItem>
              <SelectItem hideIndicator value="shadow">
                Shadow
              </SelectItem>
              <SelectItem hideIndicator value="teacher">
                Teacher
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        title="Shadow consent"
        description="Shadow sends another copy of the task to OpenRouter. It may incur extra cost. Completions are discarded. Enable only with this explicit consent."
        control={
          <Switch
            checked={guidance.shadowConsent}
            onCheckedChange={(checked) =>
              updateSettings({
                openRouter: { ...guidance, shadowConsent: Boolean(checked) },
              })
            }
            aria-label="Consent to Shadow OpenRouter observation"
          />
        }
      />
      {guidance.guidanceMode === "shadow" && !guidance.shadowConsent ? (
        <p
          className="text-2xs text-warning-foreground"
          data-openrouter-shadow-warning="true"
          role="alert"
        >
          Shadow is selected but consent is off. No observation request will be sent.
        </p>
      ) : null}
      {guidance.guidanceMode === "shadow" && guidance.shadowConsent ? (
        <p
          className="text-2xs text-warning-foreground"
          data-openrouter-shadow-warning="true"
          role="alert"
        >
          Shadow uploads a second copy of the task under Zero Data Retention and denied provider
          collection. It does not change the current answer, and it can still cost tokens.
        </p>
      ) : null}
      {guidance.guidanceMode === "teacher" && !guidance.teacherEnabled ? (
        <p
          className="text-2xs text-warning-foreground"
          data-openrouter-teacher-warning="true"
          role="alert"
        >
          Teacher is selected but not enabled. Enable Teacher to let OpenRouter Auto execute inside
          the eligible set. This does not replace Auto Route or Manual.
        </p>
      ) : null}
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        title="Teacher enabled"
        description="Teacher is opt-in. OpenRouter Auto selects and executes a model from the Base3Router eligible set only."
        control={
          <Switch
            checked={guidance.teacherEnabled}
            onCheckedChange={(checked) =>
              updateSettings({
                openRouter: { ...guidance, teacherEnabled: Boolean(checked) },
              })
            }
            aria-label="Enable OpenRouter Teacher"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        title="Teacher fallback to Auto Route"
        description="If OpenRouter is unavailable, use bounded Base3Router failover. This does not convert Teacher into Shadow."
        control={
          <Switch
            checked={guidance.teacherFallbackToBase3}
            onCheckedChange={(checked) =>
              updateSettings({
                openRouter: { ...guidance, teacherFallbackToBase3: Boolean(checked) },
              })
            }
            aria-label="Teacher fallback to Base3Router"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["openRouter"]}
        title="Cost tier"
        description="OpenRouter Auto cost band. This is not a dollar ceiling. Base3Router eligibility remains the hard constraint."
        control={
          <Select
            value={guidance.costTier}
            onValueChange={(value) => {
              if (
                value === "low" ||
                value === "medium" ||
                value === "high" ||
                value === "xhigh" ||
                value === "max"
              ) {
                updateSettings({ openRouter: { ...guidance, costTier: value } });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="OpenRouter cost tier">
              <SelectValue>{COST_LABEL[guidance.costTier]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(COST_LABEL) as OpenRouterCostTier[]).map((tier) => (
                <SelectItem hideIndicator key={tier} value={tier}>
                  {COST_LABEL[tier]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <p className="text-2xs text-muted-foreground">
        Privacy: Zero Data Retention and denied provider data collection. Plugins and tools stay
        off. Set OPENROUTER_API_KEY on the server or provider instance environment. Never paste a
        key into chat.
      </p>
    </SettingsSection>
  );
}
