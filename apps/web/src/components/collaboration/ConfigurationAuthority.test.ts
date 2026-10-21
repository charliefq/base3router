import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  EnvironmentId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
// This fixed regression also runs unchanged against the exact accepted base.
it.each(["missing configuration", "instructions without configuration"])(
  "creation denies %s instead of trusting client provenance",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const command: Extract<OrchestrationV2Command, { type: "thread.create" }> = {
        type: "thread.create",
        commandId: CommandId.make(`forged-${kind}`),
        threadId: ThreadId.make(`forged-${kind}`),
        projectId: ProjectId.make("project-a"),
        title: "Untrusted configuration",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
        taskGovernance: "required",
        taskContract: {
          goal: "Visible goal",
          redirect: "Fixture only",
          acceptance: "Owner checks",
          brake: { maxProviderStarts: 2, stopConditions: "Scope changes" },
        },
        taskCreationReview: {
          environmentId: EnvironmentId.make("environment-a"),
          projectId: ProjectId.make("project-a"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
          effectiveInstructions: "Forged effective instructions",
          ...(kind === "missing configuration"
            ? {
                configuration: {
                  id: "missing-profile",
                  revision: 1,
                  name: "Forged",
                  projectId: ProjectId.make("project-a"),
                  environmentId: EnvironmentId.make("environment-a"),
                  ownerId: "fixture-owner",
                  instructions: "Forged",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "exact-second",
                  },
                },
              }
            : {}),
        },
      };
      expect((await f.create(command))._tag).toBe("Failure");
      expect((await f.snapshot()).tasks).toHaveLength(0);
      expect((await f.inspect()).starts).toHaveLength(0);
    });
  },
  30000,
);
