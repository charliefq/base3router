import {
  ControllerBridgeFailure,
  ControllerTaskView,
  ControllerTool,
  ControllerToolInputs,
  type ControllerInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const controllerActions = ControllerTool.literals;
export type ControllerAction = ControllerTool;
export type ControllerKind = "grokbot" | "muse" | "dot";
export type ControllerTransport =
  | { protocol: "http"; post(path: string, input: unknown): Promise<unknown> }
  | { protocol: "mcp"; callTool(name: ControllerTool, input: unknown): Promise<unknown> };
type FailureCode =
  | typeof ControllerBridgeFailure.Type.error
  | "uncertain"
  | "incompatible_response"
  | "invalid_input";
export class ControllerClientError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(`Controller bridge: ${code}.`);
    this.code = code;
  }
}
const McpResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
});
const isFailure = Schema.is(ControllerBridgeFailure);
const decodeMcpResult = Schema.decodeUnknownSync(McpResult);
const decodeFailureJson = Schema.decodeUnknownSync(Schema.fromJsonString(ControllerBridgeFailure));
const decodeTaskView = Schema.decodeUnknownSync(ControllerTaskView);
function decodeReply(
  protocol: ControllerTransport["protocol"],
  reply: unknown,
): ControllerTaskView {
  if (isFailure(reply)) throw new ControllerClientError(reply.error);
  let output = reply;
  if (protocol === "mcp") {
    let result: typeof McpResult.Type;
    try {
      result = decodeMcpResult(reply);
    } catch {
      throw new ControllerClientError("incompatible_response");
    }
    if (result.isError) {
      for (const content of result.content ?? []) {
        if (content.type !== "text" || !content.text) continue;
        try {
          const failure = decodeFailureJson(content.text);
          throw new ControllerClientError(failure.error);
        } catch (error) {
          if (error instanceof ControllerClientError) throw error;
        }
      }
      throw new ControllerClientError("unavailable");
    }
    output = result.structuredContent;
  }
  try {
    return decodeTaskView(output);
  } catch {
    throw new ControllerClientError("incompatible_response");
  }
}
/** No credentials here. The external MCP/HTTP host owns controller authentication. */
export function createControllerClient(transport: ControllerTransport, controllerId: string) {
  const prepare = <A extends ControllerTool>(action: A, input: ControllerInput<A>) => {
    // Capture one reviewed payload/key before sending. Recovery sends this exact snapshot,
    // even if the caller or transport later mutates its object. There is no automatic retry.
    let serialized: string;
    const targetTask = "taskId" in input ? input.taskId : null;
    const targetProject = "projectId" in input ? input.projectId : null;
    try {
      const schema = ControllerToolInputs[action] as Schema.Codec<ControllerInput<A>, unknown>;
      const decoded = Schema.decodeUnknownSync(schema)(input, { onExcessProperty: "error" });
      serialized = JSON.stringify(decoded);
    } catch {
      throw new ControllerClientError("invalid_input");
    }
    return {
      async send(): Promise<ControllerTaskView> {
        let reply: unknown;
        try {
          const payload: unknown = JSON.parse(serialized);
          reply =
            transport.protocol === "http"
              ? await transport.post(`/api/controller/v1/tools/${action}`, payload)
              : await transport.callTool(action, payload);
        } catch {
          throw new ControllerClientError("uncertain");
        }
        const view = decodeReply(transport.protocol, reply);
        if (
          view.controllerId !== controllerId ||
          (targetTask !== null && view.taskId !== targetTask) ||
          (targetProject !== null && view.projectId !== targetProject)
        ) {
          throw new ControllerClientError("incompatible_response");
        }
        return view;
      },
    };
  };
  return {
    prepare,
    call: <A extends ControllerTool>(action: A, input: ControllerInput<A>) =>
      prepare(action, input).send(),
  };
}
