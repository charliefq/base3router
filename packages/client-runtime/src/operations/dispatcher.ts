import { WS_METHODS, type DispatcherRoutePreviewRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

/** Read the server-authoritative dispatcher decision without starting provider work. */
export const previewRoute = Effect.fn("EnvironmentDispatcher.previewRoute")(function* (
  input: DispatcherRoutePreviewRequest,
) {
  return yield* request(WS_METHODS.dispatcherRoutePreview, input);
});
