import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@t3tools/contracts";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as TovioVcsDriver from "./TovioVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
// Detection costs three git processes per cwd; cached hits still stat disk, so TTL bounds only undetectable changes.
const DETECTION_CACHE_TTL = Duration.minutes(5);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
  }
>()("t3/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const tovio = (yield* TovioVcsDriver.enabled) ? yield* TovioVcsDriver.make : undefined;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
    ...(tovio ? { tovio: tovio.driver } : {}),
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    const gitHandle = yield* detectWithDriver("git", git, input.cwd);
    if (!tovio) return gitHandle;
    const nativeRoot = yield* tovio.findRoot(input.cwd);
    if (nativeRoot === null) return gitHandle;
    if (gitHandle) {
      const relative = path.relative(nativeRoot, gitHandle.repository.rootPath);
      if (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
        return gitHandle;
    }
    return {
      kind: "tovio",
      repository: yield* tovio.open(nativeRoot),
      driver: tovio.driver,
    } satisfies VcsDriverHandle;
  });

  // Symlinks can put cwd outside root; then inspect cwd alone.
  const foldersBelowRoot = (cwd: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return [cwd];
    return Array.from(
      { length: relative === "" ? 1 : relative.split(path.sep).length + 1 },
      (_, levelsUp) => path.resolve(cwd, ...Array<string>(levelsUp).fill("..")),
    );
  };

  const readDiskState = (cwd: string, repository: VcsRepositoryIdentity) =>
    Effect.all({
      markers: Effect.forEach(foldersBelowRoot(cwd, repository.rootPath), (folder) =>
        Effect.forEach(tovio ? [".git", ".tovio"] : [".git"], (marker) =>
          fileSystem.exists(path.join(folder, marker)),
        ),
      ).pipe(Effect.map((entries) => entries.flat())),
      repositoryOnDisk: Effect.forEach(
        repository.metadataPath === null
          ? [cwd]
          : [cwd, path.resolve(cwd, repository.metadataPath)],
        (target) => fileSystem.exists(target),
      ).pipe(Effect.map((results) => results.every(Boolean))),
    }).pipe(Effect.orElseSucceed(() => null));

  const detectionCache = yield* Cache.makeWith<
    string,
    { readonly handle: VcsDriverHandle; readonly markers: ReadonlyArray<boolean> } | null,
    VcsError
  >(
    (key) =>
      Effect.gen(function* () {
        const input = parseDetectionCacheKey(key);
        const handle = yield* detectResolvedKind(input);
        if (handle === null) return null;
        const disk = yield* readDiskState(input.cwd, handle.repository);
        return { handle, markers: disk?.markers ?? [] };
      }),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) => (detected === null ? Duration.zero : DETECTION_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      const key = detectionCacheKey({ cwd: input.cwd, requestedKind });
      const cached = yield* Cache.get(detectionCache, key);
      if (cached === null) return null;
      const disk = yield* readDiskState(input.cwd, cached.handle.repository);
      if (
        disk?.repositoryOnDisk &&
        disk.markers.length === cached.markers.length &&
        disk.markers.every((exists, index) => exists === cached.markers[index])
      ) {
        return cached.handle;
      }
      yield* Cache.invalidate(detectionCache, key);
      return (yield* Cache.get(detectionCache, key))?.handle ?? null;
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
