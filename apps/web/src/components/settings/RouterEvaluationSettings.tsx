import { DEFAULT_ROUTER_EVALUATION_SETTINGS } from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { usePrimaryEnvironment } from "../../state/environments";

export function RouterEvaluationSettings() {
  const settings = useScopedSettings((value) => value.routerEvaluation);
  const updateSettings = useUpdateScopedSettings();
  const environment = usePrimaryEnvironment();
  const capability = environment?.serverConfig?.environment.capabilities.routerEvaluation;
  if (capability === undefined) return null;

  const evaluation = settings ?? DEFAULT_ROUTER_EVALUATION_SETTINGS;

  return (
    <SettingsSection id="router-evaluation" title="Router evaluation">
      <SettingsRow
        serverScoped
        settingKeys={["routerEvaluation"]}
        {...searchableSetting("router-evaluation")}
        description="Local measurement stays on this environment. Observations never include prompts, completions, or API keys, and are never uploaded."
        control={
          <p className="text-2xs text-muted-foreground" data-router-evaluation-count="">
            {capability.observationCount} observations · policy {capability.activePolicyVersion}
          </p>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["routerEvaluation"]}
        title="Local measurement"
        description="When off, new observations are not recorded. Existing records remain until retention or delete."
        control={
          <Switch
            checked={evaluation.measurementEnabled}
            onCheckedChange={(checked) =>
              updateSettings({
                routerEvaluation: { ...evaluation, measurementEnabled: Boolean(checked) },
              })
            }
            aria-label="Enable local routing measurement"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["routerEvaluation"]}
        title="Policy Shadow"
        description="Policy Shadow calculates what Hybrid Router V1 would select without changing execution or making a second model request. This is not OpenRouter Shadow."
        control={
          <Switch
            checked={evaluation.challengerShadowEnabled}
            onCheckedChange={(checked) =>
              updateSettings({
                routerEvaluation: { ...evaluation, challengerShadowEnabled: Boolean(checked) },
              })
            }
            aria-label="Enable Policy Shadow challenger"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["routerEvaluation"]}
        title="Retention"
        description="Local observations older than this window are deleted. Export first if you need a copy. Nothing is uploaded."
        control={
          <Select
            value={String(evaluation.retentionDays)}
            onValueChange={(value) => {
              const retentionDays = Number(value);
              if (retentionDays === 30 || retentionDays === 90 || retentionDays === 180) {
                updateSettings({
                  routerEvaluation: { ...evaluation, retentionDays },
                });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label="Observation retention period"
            >
              <SelectValue>
                {evaluation.retentionDays === 30
                  ? "30 days"
                  : evaluation.retentionDays === 180
                    ? "180 days"
                    : "90 days"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="30">
                30 days
              </SelectItem>
              <SelectItem hideIndicator value="90">
                90 days
              </SelectItem>
              <SelectItem hideIndicator value="180">
                180 days
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
