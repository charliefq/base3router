import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WS_METHODS, WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

const decodeSubscribeServerConfigPayload = Schema.decodeUnknownSync(
  WsSubscribeServerConfigRpc.payloadSchema,
);

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = decodeSubscribeServerConfigPayload({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = decodeSubscribeServerConfigPayload({});
    expect(decoded).toEqual({});
  });
});

describe("router evaluation RPC", () => {
  it("registers insights, export, delete, feedback, and policy lifecycle", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.routerGetInsights)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerExportObservations)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerDeleteObservations)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerSubmitFeedback)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerListPolicies)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerInspectPolicy)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerActivatePolicy)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerShadowPolicy)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.routerRollbackPolicy)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.actionGateGetGovernance)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.actionGateRespondApproval)).toBe(true);
  });
});

describe("dispatcher route preview RPC", () => {
  it("is registered as a bounded unary request", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.dispatcherRoutePreview)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.dispatcherHandoffPreview)).toBe(true);
  });
});

describe("cursor-cloud workflow RPC", () => {
  it("registers follow-up, cancel, and refresh as bounded unary requests", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.workflowCursorCloudFollowUp)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.workflowCursorCloudCancel)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.workflowCursorCloudRefresh)).toBe(true);
  });
});
