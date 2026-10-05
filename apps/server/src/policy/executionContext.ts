import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Context from "effect/Context";

export type PolicyExecutionContext =
  | { readonly kind: "absent" }
  | {
      readonly kind: "kernel-test";
      readonly actorId: "kernel-test";
      readonly scopes: readonly ["orchestration:operate"];
    }
  | {
      readonly kind: "session";
      readonly actorId: string;
      readonly sessionId: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      readonly expiresAt?: string;
    }
  | { readonly kind: "server-continuation" };

const kernelTest = {
  kind: "kernel-test" as const,
  actorId: "kernel-test" as const,
  scopes: ["orchestration:operate"] as const,
};

/**
 * Identity comes from the authenticated fiber, never from a model claim.
 * Vitest defaults to a kernel subject so upstream V2 tests keep running.
 * Production defaults to absent and denies execution until a session or
 * continuation is provided. A session context is enforced even under Vitest.
 */
export const PolicyExecutionContext = Context.Reference<PolicyExecutionContext>(
  "base3/PolicyExecutionContext",
  {
    defaultValue: () => (process.env.VITEST ? kernelTest : { kind: "absent" as const }),
  },
);

export const kernelTestPolicyContext: PolicyExecutionContext = kernelTest;
