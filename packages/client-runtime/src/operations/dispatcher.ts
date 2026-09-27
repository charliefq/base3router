import {
  WS_METHODS,
  type DispatcherHandoffPreviewRequest,
  type DispatcherRoutePreviewRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

/** Read the server-authoritative dispatcher decision without starting provider work. */
export const previewRoute = Effect.fn("EnvironmentDispatcher.previewRoute")(function* (
  input: DispatcherRoutePreviewRequest,
) {
  return yield* request(WS_METHODS.dispatcherRoutePreview, input);
});

/** Build and validate a bounded handoff packet without starting provider work. */
export const previewHandoff = Effect.fn("EnvironmentDispatcher.previewHandoff")(function* (
  input: DispatcherHandoffPreviewRequest,
) {
  return yield* request(WS_METHODS.dispatcherHandoffPreview, input);
});
