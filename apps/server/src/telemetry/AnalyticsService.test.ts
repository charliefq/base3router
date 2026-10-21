import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

// Synthetic identity only: even enabled telemetry tests must never read the test runner's account.
const syntheticIdentityServices = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs): FileSystem.FileSystem => ({
    ...fs,
    readFileString: (path, ...options) =>
      path.endsWith("/.codex/auth.json") || path.endsWith("\\.codex\\auth.json")
        ? Effect.succeed(JSON.stringify({ tokens: { account_id: "synthetic-analytics-account" } }))
        : path.endsWith("/.claude.json") || path.endsWith("\\.claude.json")
          ? Effect.succeed(JSON.stringify({ userID: "synthetic-analytics-user" }))
          : fs.readFileString(path, ...options),
  })),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(syntheticIdentityServices)("AnalyticsService test", (it) => {
  it.effect("invalid telemetry configuration is not treated as a disabled service", () =>
    Effect.gen(function* () {
      const result = yield* AnalyticsService.make.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: "invalid" })),
        ),
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-invalid-analytics-" })),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Invalid analytics must not send")),
        ),
        Effect.exit,
      );
      assert.equal(result._tag, "Failure");
    }),
  );
  it.effect(
    "disabled construction, record and flush perform no identity reads or timer scheduling",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const accountReads: string[] = [];
        const clock = yield* Clock.Clock;
        let sleeps = 0;
        const guardedFs = {
          ...fs,
          readFileString: (...args: Parameters<typeof fs.readFileString>) => {
            const [path] = args;
            if (path.endsWith("auth.json") || path.endsWith(".claude.json"))
              accountReads.push(path);
            return fs.readFileString(...args);
          },
        };
        const config = ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-disabled-analytics-inert-",
        });
        yield* Effect.gen(function* () {
          const analytics = yield* AnalyticsService.make;
          yield* analytics.record("disabled.synthetic");
          yield* analytics.flush;
          assert.deepEqual(accountReads, []);
          yield* Effect.yieldNow;
          assert.equal(sleeps, 0);
        }).pipe(
          Effect.provide(config),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: false })),
          ),
          Effect.provideService(FileSystem.FileSystem, guardedFs),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Disabled analytics must not send")),
          ),
          Effect.provideService(Clock.Clock, {
            ...clock,
            sleep: () =>
              Effect.sync(() => {
                sleeps++;
              }).pipe(Effect.andThen(Effect.never)),
          }),
        );
      }),
  );
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
