import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";
const fixture = vi.hoisted(() => ({
  requests: [] as unknown[],
  session: { environmentId: "env-a" },
}));
vi.mock("../../../state/controllerOwner", () => ({
  controllerOwnerCommand: { label: "fixture-owner-command" },
}));
vi.mock("../../../state/session", () => ({
  usePreparedConnection: () => Option.some(fixture.session),
}));
vi.mock("../../../state/use-atom-command", () => {
  const request = async (input: unknown) => {
    fixture.requests.push(input);
    return { _tag: "Success", value: { status: 200, body: { version: 1, identities: [] } } };
  };
  return { useAtomCommand: () => request };
});
import { OwnerControllerConnect } from "./OwnerControllerConnect";
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
it("injects the selected environment owner transport into the production panel and isolates switches", async () => {
  const props = { projects: [], onProviderSetup: () => {}, onClose: () => {} };
  await act(async () => {
    renderer = create(
      <OwnerControllerConnect {...props} environmentId={EnvironmentId.make("env-a")} />,
    );
  });
  const button = () =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Load controller identities"))!;
  await act(async () => button().props.onClick());
  expect(fixture.requests).toEqual([
    { environmentId: "env-a", input: { operation: "identities" } },
  ]);
  await act(async () =>
    renderer.update(
      <OwnerControllerConnect {...props} environmentId={EnvironmentId.make("env-b")} />,
    ),
  );
  expect(button().props.disabled).toBe(true);
  fixture.session = { environmentId: "env-b" };
  await act(async () =>
    renderer.update(
      <OwnerControllerConnect {...props} environmentId={EnvironmentId.make("env-b")} />,
    ),
  );
  await act(async () => button().props.onClick());
  expect(fixture.requests[1]).toEqual({
    environmentId: "env-b",
    input: { operation: "identities" },
  });
});
