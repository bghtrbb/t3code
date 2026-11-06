import {
  TovioStatus,
  TovioLane,
  TovioPinnedProposal,
  TovioProposal,
  TovioReview,
  type TovioInspectInput,
  type TovioMutateInput,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

export const enabled = HostProcess.Environment.pipe(
  Effect.map((env) => env.T3CODE_ENABLE_TOVIO === "1"),
);

const unavailable = (operation: string, detail: string) =>
  new VcsUnsupportedOperationError({ kind: "tovio", operation, detail });

const Capabilities = Schema.Struct({
  version: Schema.Literal(1),
  vcs: Schema.Literal(true),
  forge_review: Schema.optional(Schema.Boolean),
  checkpoints: Schema.optional(Schema.Boolean),
});
const Repository = Schema.Struct({ root: Schema.String });
const Files = Schema.Struct({ paths: Schema.Array(Schema.String) });
const Remotes = Schema.Struct({
  remotes: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
});
const CliError = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const decodeCliError = Schema.decodeOption(Schema.fromJsonString(CliError));
const decodeCliResult = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown })),
);
const CheckpointExists = Schema.Struct({ exists: Schema.Boolean });
const CheckpointDiff = Schema.Struct({
  changes: Schema.Array(Schema.Struct({ path: Schema.String })),
});
const LanesResponse = Schema.Struct({ lanes: Schema.Array(TovioLane) });
const DiffResponse = Schema.Struct({ changes: Schema.Array(Schema.String) });
const ProposalsResponse = Schema.Struct({ proposals: Schema.Array(TovioProposal) });
const ReviewResponse = Schema.Struct({
  proposal: Schema.Struct({
    ...TovioPinnedProposal.fields,
    repository: Schema.String,
    remote: Schema.String,
  }),
  review: TovioReview,
});

const hostedForgeWebOrigins: Readonly<Record<string, string>> = {
  "https://forge.tovio.dev": "https://app.tovio.dev",
  "https://staging.forge.tovio.dev": "https://staging.app.tovio.dev",
};

function forgeReviewUrl(
  remote: string,
  repository: string,
  proposal: string,
  configured: string | undefined,
): string | undefined {
  const endpoint = URL.parse(remote);
  const origin = endpoint?.origin ?? "";
  const url = URL.parse(configured ?? hostedForgeWebOrigins[origin] ?? origin);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search) {
    return undefined;
  }
  const hostedRepository = endpoint?.pathname.match(/^\/repos\/([\w.-]+(?:\/[\w.-]+)?)\/?$/u)?.[1];
  const route = (hostedRepository ?? repository).replaceAll("/", "~");
  url.hash = `/repo/${encodeURIComponent(route)}/review/${encodeURIComponent(proposal)}`;
  return url.toString();
}

function mutationArgs(action: TovioMutateInput["action"]): ReadonlyArray<string> {
  switch (action.kind) {
    case "commit":
      return ["commit", `--message=${action.message}`];
    case "createLane":
      return ["lane", "--", action.lane];
    case "switchLane":
      return ["switch", "--", action.lane];
    case "pull":
      return ["sync", "--pull"];
    case "push":
      return ["sync", "--push"];
    case "propose":
      return [
        "integration",
        "proposal-create",
        `--change=${action.change}`,
        `--target=${action.target}`,
        `--request-id=${action.requestId}`,
      ];
    case "decide":
      return [
        "integration",
        "proposal-decide",
        action.proposal.id,
        `--version=${action.proposal.version}`,
        `--commit=${action.proposal.commit}`,
        `--base=${action.proposal.base}`,
        `--origin=${action.proposal.origin}`,
        `--decision=${action.decision}`,
      ];
  }
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;

  const executable = resolveCommandPath(platform === "win32" ? "tovio.exe" : "tovio").pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.filterOrFail(
      (resolved): resolved is string => resolved !== null && path.isAbsolute(resolved),
      () => unavailable("TovioVcsDriver.executable", "Install TOVIO on the server PATH."),
    ),
  );

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    executable.pipe(Effect.flatMap((command) => process.run({ ...input, command })));

  const json = Effect.fn("TovioVcsDriver.json")(function* <A>(
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    schema: Schema.Decoder<A>,
    timeoutMs = 15_000,
  ) {
    const result = yield* execute({
      operation,
      cwd,
      args: ["--json", "--no-sync", ...args],
      timeoutMs,
      maxOutputBytes: 8_000_000,
      allowNonZeroExit: true,
    });
    const invalid = () => unavailable(operation, "TOVIO returned an incompatible response.");
    if (result.stdoutTruncated || result.stdoutInvalidUtf8) return yield* invalid();
    if (result.exitCode !== 0) {
      const failure = decodeCliError(result.stdout);
      const code =
        Option.isSome(failure) && /^TVO-[A-Z]+-\d+$/u.test(failure.value.error.code)
          ? ` (${failure.value.error.code})`
          : "";
      return yield* unavailable(operation, `TOVIO refused the operation${code}.`);
    }
    return yield* decodeCliResult(result.stdout).pipe(
      Effect.flatMap(({ result }) => Schema.decodeUnknownEffect(schema)(result)),
      Effect.mapError(invalid),
    );
  });

  const probe = (cwd: string) =>
    json("TovioVcsDriver.probe", cwd, ["integration", "capabilities"], Capabilities, 5_000).pipe(
      Effect.mapError(() =>
        unavailable(
          "TovioVcsDriver.probe",
          "Install a TOVIO CLI with integration contract v1 on the server.",
        ),
      ),
    );

  const requireReview = (cwd: string) =>
    probe(cwd).pipe(
      Effect.filterOrFail(
        ({ forge_review }) => forge_review === true,
        () =>
          unavailable(
            "TovioVcsDriver.requireReview",
            "Install a TOVIO CLI with Tovio Cloud review support on the server.",
          ),
      ),
    );

  const findRoot = Effect.fn("TovioVcsDriver.findRoot")(function* (cwd: string) {
    let folder = path.resolve(cwd);
    for (;;) {
      const marker = yield* fs.exists(path.join(folder, ".tovio")).pipe(
        Effect.mapError(
          () =>
            new VcsRepositoryDetectionError({
              operation: "TovioVcsDriver.findRoot",
              cwd,
              detail: "Could not inspect the TOVIO repository marker.",
            }),
        ),
      );
      if (marker) return folder;
      const parent = path.dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  });

  const freshness = DateTime.now.pipe(
    Effect.map((observedAt) => ({
      source: "live-local" as const,
      observedAt,
      expiresAt: Option.none(),
    })),
  );

  const open = Effect.fn("TovioVcsDriver.open")(function* (root: string) {
    yield* probe(root);
    const { root: rootPath } = yield* json(
      "TovioVcsDriver.open",
      root,
      ["integration", "repository"],
      Repository,
      5_000,
    );
    const canonicalRoot = yield* fs
      .realPath(root)
      .pipe(
        Effect.mapError(() =>
          unavailable("TovioVcsDriver.open", "Could not resolve the TOVIO repository root."),
        ),
      );
    if (!path.isAbsolute(rootPath) || path.relative(canonicalRoot, rootPath) !== "") {
      return yield* unavailable(
        "TovioVcsDriver.open",
        "TOVIO reported a different repository root.",
      );
    }
    return {
      kind: "tovio" as const,
      rootPath,
      metadataPath: path.join(rootPath, ".tovio"),
      freshness: yield* freshness,
    };
  });

  const detectRepository = Effect.fn("TovioVcsDriver.detectRepository")(function* (cwd: string) {
    const root = yield* findRoot(cwd);
    return root === null ? null : yield* open(root);
  });

  const requireRoot = (cwd: string) =>
    findRoot(cwd).pipe(
      Effect.filterOrFail(
        (root): root is string => root !== null,
        () => unavailable("TovioVcsDriver.requireRoot", "No TOVIO repository was found."),
      ),
    );

  const listWorkspaceFiles = Effect.fn("TovioVcsDriver.listWorkspaceFiles")(function* (
    cwd: string,
  ) {
    const root = yield* requireRoot(cwd);
    const { paths } = yield* json(
      "TovioVcsDriver.listWorkspaceFiles",
      root,
      ["integration", "files"],
      Files,
    );
    const relative = path.relative(root, path.resolve(cwd)).split(path.sep).join("/");
    const selected =
      relative === ""
        ? paths
        : paths
            .filter((file) => file.startsWith(`${relative}/`))
            .map((file) => file.slice(relative.length + 1));
    return { paths: selected, truncated: false, freshness: yield* freshness };
  });

  const listRemotes = Effect.fn("TovioVcsDriver.listRemotes")(function* (cwd: string) {
    const root = yield* requireRoot(cwd);
    const { remotes } = yield* json(
      "TovioVcsDriver.listRemotes",
      root,
      ["remote", "list"],
      Remotes,
    );
    return {
      remotes: remotes.map(({ name, url }) => ({
        name,
        url,
        isPrimary: name === "origin",
        pushUrl: Option.none(),
      })),
      freshness: yield* freshness,
    };
  });

  const checkpoint = Effect.fn("TovioVcsDriver.checkpoint")(function* <A>(
    cwd: string,
    args: ReadonlyArray<string>,
    schema: Schema.Decoder<A>,
  ) {
    const root = yield* requireRoot(cwd);
    if (path.relative(root, path.resolve(cwd)) !== "") {
      return yield* unavailable(
        "TovioVcsDriver.checkpoint",
        "Checkpoint scope must be the TOVIO root.",
      );
    }
    return yield* json(
      "TovioVcsDriver.checkpoint",
      root,
      ["integration", "checkpoint", ...args],
      schema,
      120_000,
    );
  });
  const checkpointDiff = Effect.fn("TovioVcsDriver.checkpointDiff")(
    (input: VcsDriver.VcsDiffCheckpointsInput) =>
      checkpoint(
        input.cwd,
        ["diff", "--", input.fromCheckpointRef, input.toCheckpointRef],
        CheckpointDiff,
      ),
  );

  const inspect = Effect.fn("TovioVcsDriver.inspect")(function* (input: TovioInspectInput) {
    if (input.operation === "proposals" || input.operation === "review") {
      yield* requireReview(input.cwd);
    }
    if (input.operation === "lanes") {
      const { lanes } = yield* json(
        "TovioVcsDriver.lanes",
        input.cwd,
        ["integration", "lanes"],
        LanesResponse,
      );
      return { operation: "lanes" as const, lanes };
    }
    if (input.operation === "proposals") {
      const result = yield* json(
        "TovioVcsDriver.proposals",
        input.cwd,
        ["integration", "proposals", `--target=${input.target}`],
        ProposalsResponse,
      );
      return { operation: "proposals" as const, ...result };
    }
    if (input.operation === "review") {
      const { proposal, review } = yield* json(
        "TovioVcsDriver.review",
        input.cwd,
        ["integration", "proposal-review", input.proposal],
        ReviewResponse,
      );
      const { remote, repository, ...pins } = proposal;
      const configured = (yield* HostProcess.Environment).T3CODE_TOVIO_FORGE_WEB_URL;
      const webUrl = forgeReviewUrl(remote, repository, pins.id, configured);
      return {
        operation: "review" as const,
        proposal: pins,
        review,
        ...(webUrl ? { webUrl } : {}),
      };
    }
    const { changes } = yield* json("TovioVcsDriver.diff", input.cwd, ["diff"], DiffResponse);
    return { operation: "diff" as const, changes };
  });

  const driver = VcsDriver.VcsDriver.of({
    execute,
    tovio: {
      canCheckpoint: Effect.fn("TovioVcsDriver.canCheckpoint")(function* (cwd) {
        const root = yield* requireRoot(cwd);
        return (
          path.relative(root, path.resolve(cwd)) === "" && (yield* probe(root)).checkpoints === true
        );
      }),
      status: Effect.fn("TovioVcsDriver.status")((cwd) =>
        json("TovioVcsDriver.status", cwd, ["integration", "status"], TovioStatus),
      ),
      inspect,
      mutate: Effect.fn("TovioVcsDriver.mutate")(function* (input) {
        if (input.action.kind === "propose" || input.action.kind === "decide") {
          yield* requireReview(input.cwd);
        }
        yield* json(
          "TovioVcsDriver.mutate",
          input.cwd,
          mutationArgs(input.action),
          Schema.Unknown,
          120_000,
        );
      }),
    },
    detectRepository,
    isInsideWorkTree: Effect.fn("TovioVcsDriver.isInsideWorkTree")((cwd) =>
      detectRepository(cwd).pipe(Effect.map((repository) => repository !== null)),
    ),
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths: Effect.fn("TovioVcsDriver.filterIgnoredPaths")((cwd, relativePaths) =>
      listWorkspaceFiles(cwd).pipe(
        Effect.map(({ paths }) => {
          const selected = new Set(paths);
          return relativePaths.filter((candidate) => selected.has(candidate));
        }),
      ),
    ),
    initRepository: Effect.fn("TovioVcsDriver.initRepository")((input) =>
      probe(input.cwd).pipe(
        Effect.andThen(
          json(
            "TovioVcsDriver.initRepository",
            input.cwd,
            ["init", "--mode", "simple"],
            Schema.Unknown,
          ),
        ),
        Effect.asVoid,
      ),
    ),
    checkpoints: {
      captureCheckpoint: Effect.fn("TovioVcsDriver.captureCheckpoint")((input) =>
        checkpoint(input.cwd, ["capture", "--", input.checkpointRef], Schema.Unknown).pipe(
          Effect.asVoid,
        ),
      ),
      hasCheckpointRef: Effect.fn("TovioVcsDriver.hasCheckpointRef")((input) =>
        checkpoint(input.cwd, ["exists", "--", input.checkpointRef], CheckpointExists).pipe(
          Effect.map(({ exists }) => exists),
        ),
      ),
      restoreCheckpoint: Effect.fn("TovioVcsDriver.restoreCheckpoint")(function* (input) {
        if (!input.expectedCurrentCheckpointRef) {
          return yield* unavailable(
            "TovioVcsDriver.restoreCheckpoint",
            "TOVIO requires the latest checkpoint as a restore guard.",
          );
        }
        yield* checkpoint(
          input.cwd,
          ["restore", "--", input.expectedCurrentCheckpointRef, input.checkpointRef],
          Schema.Unknown,
        );
        return true;
      }),
      diffCheckpoints: Effect.fn("TovioVcsDriver.diffCheckpoints")(function* (input) {
        if (input.format !== "numstat") {
          return yield* unavailable(
            "TovioVcsDriver.diffCheckpoints",
            "TOVIO checkpoints provide file summaries.",
          );
        }
        const { changes } = yield* checkpointDiff(input);
        const selected =
          input.filePaths === undefined
            ? changes
            : changes.filter(({ path }) => input.filePaths!.includes(path));
        return selected.map(({ path }) => `-\t-\t${path}\0`).join("");
      }),
      listAuthoredPaths: Effect.fn("TovioVcsDriver.listAuthoredPaths")((input) =>
        checkpointDiff({ ...input, ignoreWhitespace: false }).pipe(
          Effect.map(({ changes }) => new Set(changes.map(({ path }) => path))),
        ),
      ),
      deleteCheckpointRefs: Effect.fn("TovioVcsDriver.deleteCheckpointRefs")((input) =>
        checkpoint(input.cwd, ["release", "--", ...input.checkpointRefs], Schema.Unknown).pipe(
          Effect.asVoid,
        ),
      ),
    },
  });

  return { driver, findRoot, open, probe, json };
});
