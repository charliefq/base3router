import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { INDEPENDENT_SCROLL_SURFACE_CLASS } from "~/components/controlPlane/workspaceScrollLayout";
import type { LabMessage, LabScenarioState } from "./scenarios";

export function LabConversation(props: {
  readonly scenario: LabScenarioState;
  readonly messages: ReadonlyArray<LabMessage>;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-ui-lab="conversation">
      <WorkspacePageHeader>
        <div className="min-w-0">
          <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">Task</p>
          <h1 className="truncate text-sm font-medium">{props.scenario.label}</h1>
        </div>
        <p
          className="ms-auto text-2xs text-muted-foreground"
          data-ui-lab-thread-status={props.scenario.threadStatus}
        >
          {props.scenario.threadStatus}
        </p>
      </WorkspacePageHeader>
      <div
        className={`${INDEPENDENT_SCROLL_SURFACE_CLASS} px-4 py-3`}
        data-workspace-scroll-surface="conversation"
      >
        {props.messages.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-ui-lab="empty-conversation">
            New thread. Auto Route will pick an authorized model when you send.
          </p>
        ) : (
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {props.messages.map((message) => (
              <li
                className={
                  message.role === "user"
                    ? "self-end rounded-2xl bg-muted px-3 py-2 text-sm"
                    : "self-start text-sm"
                }
                data-ui-lab-message={message.role}
                key={message.id}
              >
                {message.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
