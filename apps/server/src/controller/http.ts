import * as ByteSize from "effect/ByteSize";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ControllerTool, ControllerToolInputs, ControllerBridgeFailure } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as Bridge from "./ControllerBridge.ts";
import { taskResultFeedbackLayer } from "../collaboration/store.ts";
import * as RouterEvaluation from "../routerEvaluation/RouterEvaluationService.ts";

const names = Object.keys(ControllerToolInputs) as ReadonlyArray<ControllerTool>;
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
const bearer = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7).trim()
    : "";
const isBridgeError = Schema.is(Bridge.ControllerBridgeError);
const failure = (error: unknown) => {
  const code = isBridgeError(error) ? error.code : "invalid_request";
  return json(
    { version: 1, error: code },
    code === "unauthorized"
      ? 401
      : code === "denied"
        ? 403
        : code === "stale" || code === "conflict"
          ? 409
          : code === "unavailable"
            ? 503
            : 400,
  );
};
const encodeFailure = Schema.encodeSync(Schema.fromJsonString(ControllerBridgeFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const text = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(64)),
    );
    if (Buffer.byteLength(text, "utf8") > 65536)
      return yield* new Bridge.ControllerBridgeError({ code: "invalid_request" });
    return yield* decodeJson(text).pipe(
      Effect.mapError(() => new Bridge.ControllerBridgeError({ code: "invalid_request" })),
    );
  });
const toolRoutes = names.map((tool) =>
  HttpRouter.add(
    "POST",
    `/api/controller/v1/tools/${tool}`,
    Effect.gen(function* () {
      const bridge = yield* Bridge.ControllerBridge;
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* bridge.authenticate(bearer(request));
      return json(yield* bridge.call(bearer(request), tool, yield* readBody(request)));
    }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
  ),
);
const RpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const CallParams = Schema.Struct({ name: ControllerTool, arguments: Schema.Unknown });
const decodeRpc = Schema.decodeUnknownEffect(RpcRequest);
const decodeCall = Schema.decodeUnknownEffect(CallParams);
const decodeIdentity = Schema.decodeUnknownEffect(Schema.Struct({ controllerId: Schema.String }));
/** Stateless Streamable HTTP JSON responses. No internal /mcp sessions or toolkit registrations. */
const mcpRoute = HttpRouter.add(
  "POST",
  "/api/controller/v1/mcp",
  Effect.gen(function* () {
    const bridge = yield* Bridge.ControllerBridge;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = bearer(request);
    yield* bridge.authenticate(token);
    const body = yield* readBody(request).pipe(Effect.result);
    if (body._tag === "Failure")
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON request." } },
        400,
      );
    const decoded = yield* decodeRpc(body.success, { onExcessProperty: "error" }).pipe(
      Effect.result,
    );
    if (decoded._tag === "Failure")
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } },
        400,
      );
    const rpc = decoded.success;
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
    if (rpc.method.startsWith("notifications/") && rpc.id === undefined)
      return HttpServerResponse.empty({ status: 202 });
    if (rpc.id === undefined)
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request id required." } },
        400,
      );
    switch (rpc.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "B3R Controller Tasks", version: "1" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: names.map((name) => ({
            name,
            description: `B3R controller v1 ${name}; bounded governed task operation.`,
            inputSchema: Tool.getJsonSchemaFromSchema(ControllerToolInputs[name]),
          })),
        });
      case "tools/call": {
        const decoded = yield* decodeCall(rpc.params, { onExcessProperty: "error" }).pipe(
          Effect.result,
        );
        if (decoded._tag === "Failure")
          return json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32602, message: "Invalid tool parameters." },
          });
        const params = decoded.success;
        const result = yield* bridge.call(token, params.name, params.arguments).pipe(Effect.result);
        if (result._tag === "Failure")
          return reply({
            isError: true,
            content: [
              { type: "text", text: encodeFailure({ version: 1, error: result.failure.code }) },
            ],
          });
        return reply({
          isError: false,
          content: [{ type: "text", text: encodeJson(result.success) }],
          structuredContent: result.success,
        });
      }
      default:
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: "Method not supported." },
        });
    }
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);
const admin = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth
      .authenticateHttpRequest(request)
      .pipe(Effect.mapError(() => new Bridge.ControllerBridgeError({ code: "unauthorized" })));
    return yield* effect.pipe(
      Effect.provideService(PolicyExecutionContext, {
        kind: "session",
        actorId: session.subject,
        sessionId: session.sessionId,
        scopes: session.scopes,
        ...(session.expiresAt ? { expiresAt: DateTime.formatIso(session.expiresAt) } : {}),
      }),
    );
  });
const listRoute = HttpRouter.add(
  "GET",
  "/api/controller/v1/identities",
  Effect.gen(function* () {
    const bridge = yield* Bridge.ControllerBridge;
    return json({ version: 1, identities: yield* admin(bridge.list) });
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);
const revokeRoute = HttpRouter.add(
  "POST",
  "/api/controller/v1/revoke",
  Effect.gen(function* () {
    const bridge = yield* Bridge.ControllerBridge;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* decodeIdentity(yield* readBody(request), { onExcessProperty: "error" });
    yield* admin(bridge.revoke(input.controllerId));
    return json({ version: 1, revoked: true });
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);
const statusRoute = HttpRouter.add(
  "POST",
  "/api/controller/v1/status",
  Effect.gen(function* () {
    const bridge = yield* Bridge.ControllerBridge;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* decodeIdentity(yield* readBody(request), { onExcessProperty: "error" });
    return json(yield* admin(bridge.status(input.controllerId)));
  }).pipe(Effect.catch((error) => Effect.succeed(failure(error)))),
);
const noMcpStream = HttpRouter.add(
  "GET",
  "/api/controller/v1/mcp",
  Effect.succeed(HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })),
);
export const routes = Layer.mergeAll(
  mcpRoute,
  noMcpStream,
  listRoute,
  statusRoute,
  revokeRoute,
  ...toolRoutes,
);
export const layer = routes.pipe(
  HttpRouter.provideRequest(
    Bridge.layer.pipe(
      Layer.provide(taskResultFeedbackLayer.pipe(Layer.provide(RouterEvaluation.layer))),
    ),
  ),
);
