import { CheckpointRef } from "@t3tools/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const nativeCliDir = process.env.TOVIO_TEST_CLI_DIR;
const DETECT_COMMAND = "rev-parse --is-inside-work-tree --show-toplevel --git-common-dir";

describe("VcsDriverRegistry", () => {
  const makeDiskBackedLayer = (rootDir: string, calls: string[], contractVersion = 1) =>
    Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const command = normalizeGitArgs(input.args).join(" ");
              calls.push(command);
              if (input.args.includes("proposal-review")) {
                return processOutput(
                  JSON.stringify({
                    result: {
                      proposal: {
                        id: "prop:fixture",
                        change_id: "chg:fixture",
                        state: "open",
                        target: "main",
                        version: 2,
                        revision: 0,
                        commit: "a".repeat(64),
                        base: "b".repeat(64),
                        origin: "c".repeat(64),
                        remote: "https://staging.forge.tovio.dev/repos/review-fixture",
                        repository: "d".repeat(64),
                      },
                      review: { files: [], conflicted: [] },
                    },
                  }),
                );
              }
              if (input.args.includes("integration")) {
                return processOutput(
                  JSON.stringify({
                    result: input.args.includes("capabilities")
                      ? { version: contractVersion, vcs: true, forge_review: true }
                      : { root: input.cwd },
                  }),
                );
              }
              let repoDir: string | null = input.cwd;
              while (repoDir !== null && !(yield* fs.exists(path.join(repoDir, ".git")))) {
                repoDir = repoDir === rootDir ? null : path.dirname(repoDir);
              }
              if (repoDir === null) {
                return {
                  ...processOutput(""),
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: not a git repository",
                };
              }
              if (command === DETECT_COMMAND) {
                return processOutput(
                  `true\n${repoDir}\n${path.relative(input.cwd, path.join(repoDir, ".git"))}\n`,
                );
              }
              return processOutput("");
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              Effect.orDie,
            ),
        }),
      ),
    );

  it.effect(
    "routes a colocated repository to TOVIO and preserves the nearest explicit Git checkout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tovio-registry-" });
        const nested = path.join(root, "nested");
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(path.join(root, ".git"));
        yield* fs.makeDirectory(path.join(root, ".tovio"));
        yield* fs.makeDirectory(path.join(nested, ".git"), { recursive: true });
        yield* fs.makeDirectory(bin);
        const executable = path.join(bin, platform === "win32" ? "tovio.exe" : "tovio");
        yield* fs.writeFileString(executable, "", { mode: 0o755 });
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          assert.equal((yield* registry.detect({ cwd: root }))?.kind, "tovio");
          assert.equal((yield* registry.detect({ cwd: root, requestedKind: "git" }))?.kind, "git");
          assert.equal((yield* registry.detect({ cwd: nested }))?.kind, "git");
          yield* fs.makeDirectory(path.join(nested, ".tovio"));
          assert.equal((yield* registry.detect({ cwd: nested }))?.kind, "tovio");
        }).pipe(
          Effect.provide(makeDiskBackedLayer(root, [])),
          Effect.provideService(HostProcess.Environment, { PATH: bin, T3CODE_ENABLE_TOVIO: "1" }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["missing", "incompatible"] as const)(
    "requires TOVIO setup with a %s CLI even when Git is colocated",
    (condition) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tovio-setup-" });
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(path.join(root, ".git"));
        yield* fs.makeDirectory(path.join(root, ".tovio"));
        yield* fs.makeDirectory(bin);
        if (condition === "incompatible") {
          const executable = path.join(bin, platform === "win32" ? "tovio.exe" : "tovio");
          yield* fs.writeFileString(executable, "", { mode: 0o755 });
        }
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const error = yield* registry.resolve({ cwd: root }).pipe(Effect.flip);
          assert.equal(error._tag, "VcsUnsupportedOperationError");
          if (error._tag === "VcsUnsupportedOperationError") {
            assert.match(error.detail, /Install a TOVIO CLI with integration contract v1/u);
          }
        }).pipe(
          Effect.provide(makeDiskBackedLayer(root, [], 2)),
          Effect.provideService(HostProcess.Environment, { PATH: bin, T3CODE_ENABLE_TOVIO: "1" }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("links hosted proposals to the browser app and repository name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tovio-review-link-" });
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      const executable = path.join(bin, platform === "win32" ? "tovio.exe" : "tovio");
      yield* fs.writeFileString(executable, "", { mode: 0o755 });
      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const driver = yield* registry.get("tovio");
        const result = yield* driver.tovio!.inspect({
          cwd: root,
          operation: "review",
          proposal: "prop:fixture",
        });
        assert.equal(
          result.operation === "review" && result.webUrl,
          "https://staging.app.tovio.dev/#/repo/review-fixture/review/prop%3Afixture",
        );
      }).pipe(
        Effect.provide(makeDiskBackedLayer(root, [])),
        Effect.provideService(HostProcess.Environment, { PATH: bin, T3CODE_ENABLE_TOVIO: "1" }),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.skipIf(!nativeCliDir)(
    "drives the installed TOVIO CLI through the native VCS and checkpoint contracts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tovio-cli-" });
        const environment = yield* HostProcess.Environment;
        const delimiter = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
        yield* Effect.gen(function* () {
          const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
          const driver = yield* registry.get("tovio");
          const native = driver.tovio!;
          yield* driver.initRepository({ cwd: root });
          const detected = yield* registry.resolve({ cwd: root, requestedKind: "tovio" });
          assert.equal(path.relative(root, detected.repository.rootPath), "");
          const initial = yield* native.status(root);
          const file = path.join(root, "sample.txt");
          yield* fs.writeFileString(file, "before\n");
          assert.isTrue((yield* driver.listWorkspaceFiles(root)).paths.includes("sample.txt"));
          assert.isFalse((yield* native.status(root)).clean);
          const diff = yield* native.inspect({ cwd: root, operation: "diff" });
          assert.equal(diff.operation, "diff");
          yield* native.mutate({ cwd: root, action: { kind: "commit", message: "Baseline" } });
          const committed = yield* native.status(root);
          assert.isTrue(committed.clean);
          assert.notEqual(committed.head, initial.head);
          assert.notEqual(committed.head, committed.change);
          yield* native.mutate({ cwd: root, action: { kind: "createLane", lane: "feature" } });
          yield* native.mutate({ cwd: root, action: { kind: "switchLane", lane: "feature" } });
          assert.equal((yield* native.status(root)).lane, "feature");
          const checkpoints = driver.checkpoints!;
          yield* checkpoints.captureCheckpoint({
            cwd: root,
            checkpointRef: CheckpointRef.make("before"),
          });
          yield* fs.writeFileString(file, "after\n");
          yield* checkpoints.captureCheckpoint({
            cwd: root,
            checkpointRef: CheckpointRef.make("after"),
          });
          yield* checkpoints.restoreCheckpoint({
            cwd: root,
            checkpointRef: CheckpointRef.make("before"),
            expectedCurrentCheckpointRef: CheckpointRef.make("after"),
          });
          assert.equal(yield* fs.readFileString(file), "before\n");
        }).pipe(
          Effect.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
          Effect.provideService(HostProcess.Environment, {
            ...environment,
            PATH: [nativeCliDir, environment.PATH].join(delimiter),
            T3CODE_ENABLE_TOVIO: "1",
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when a cached repository is removed from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      yield* fs.makeDirectory(path.join(repoDir, ".git"));
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);

        yield* fs.remove(path.join(repoDir, ".git"), { recursive: true });

        assert.equal(yield* registry.detect({ cwd: repoDir }), null);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects again when git init creates a repository inside a cached one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const projectDir = path.join(parentDir, "project");
      yield* fs.makeDirectory(path.join(parentDir, ".git"));
      yield* fs.makeDirectory(projectDir);
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal((yield* registry.detect({ cwd: projectDir }))?.repository.rootPath, parentDir);

        yield* fs.makeDirectory(path.join(projectDir, ".git"));

        assert.equal(
          (yield* registry.detect({ cwd: projectDir }))?.repository.rootPath,
          projectDir,
        );
      }).pipe(Effect.provide(makeDiskBackedLayer(parentDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects a repository created after a negative lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-registry-" });
      const calls: string[] = [];

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        assert.equal(yield* registry.detect({ cwd: repoDir }), null);

        yield* fs.makeDirectory(path.join(repoDir, ".git"));

        assert.equal((yield* registry.detect({ cwd: repoDir }))?.repository.rootPath, repoDir);
        assert.equal(calls.filter((call) => call === DETECT_COMMAND).length, 2);
      }).pipe(Effect.provide(makeDiskBackedLayer(repoDir, calls)));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
