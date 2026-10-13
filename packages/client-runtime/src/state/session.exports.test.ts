import { expect, it } from "vite-plus/test";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "./session.ts";
import { executeAuthenticatedEnvironmentHttpRequest as existingRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization as existingService } from "../authorization/service.ts";
it("public session exports reuse the existing request and authorization service identities", () => {
  expect(executeAuthenticatedEnvironmentHttpRequest).toBe(existingRequest);
  expect(RemoteEnvironmentAuthorization).toBe(existingService);
});
