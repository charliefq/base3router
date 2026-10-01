import type { FormEvent, KeyboardEvent, ChangeEvent } from "react";
import type { ModelRouterDecision, ModelRouterMode } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { ModelRouterControl } from "~/components/chat/ModelRouterControl";
import { ThreadErrorBanner } from "~/components/chat/ThreadErrorBanner";

export function LabComposer(props: {
  readonly mode: ModelRouterMode;
  readonly decision: ModelRouterDecision;
  readonly prompt: string;
  readonly error: string | null;
  readonly disabled?: boolean;
  readonly openRouter?: {
    readonly mode: "off" | "shadow" | "teacher";
    readonly connectionStatus: "not_configured" | "connected" | "unavailable";
  };
  readonly onModeChange: (mode: ModelRouterMode) => void;
  readonly onPromptChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onDismissError: () => void;
}) {
  return (
    <div className="shrink-0 px-3 pb-3" data-ui-lab="composer">
      <ThreadErrorBanner
        error={props.error}
        onDismiss={props.onDismissError}
        onOpenProviderSetup={() => {}}
      />
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <form
              className="flex flex-col gap-2 p-3"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                props.onSubmit();
              }}
            >
              <Textarea
                aria-label="Lab prompt"
                data-ui-lab-prompt
                disabled={props.disabled === true}
                placeholder="Send a lab prompt. No live provider credentials are used."
                value={props.prompt}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  props.onPromptChange(event.target.value)
                }
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    props.onSubmit();
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <ModelRouterControl
                  decision={props.decision}
                  disabled={props.disabled === true}
                  mode={props.mode}
                  onModeChange={props.onModeChange}
                  {...(props.openRouter !== undefined ? { openRouter: props.openRouter } : {})}
                />
                <Button
                  aria-label="Send lab prompt"
                  data-ui-lab-submit
                  disabled={props.disabled === true || props.prompt.trim().length === 0}
                  size="icon-sm"
                  type="submit"
                >
                  <ArrowUpIcon />
                </Button>
              </div>
            </form>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
