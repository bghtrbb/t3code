import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VcsDriverKind = Schema.Literals(["git", "jj", "tovio", "unknown"]);
export type VcsDriverKind = typeof VcsDriverKind.Type;

export const TovioStatus = Schema.Struct({
  root: Schema.String,
  lane: Schema.String,
  change: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  clean: Schema.Boolean,
  behind_tip: Schema.Boolean,
  changes: Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.String })),
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String })),
});
export type TovioStatus = typeof TovioStatus.Type;

const TovioProposalId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^prop:[a-zA-Z0-9._-]{1,128}$/u),
);
const TovioDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const TovioTarget = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const TovioProposal = Schema.Struct({
  id: TovioProposalId,
  change_id: Schema.String,
  state: Schema.String,
  target: Schema.String,
  version: Schema.Int,
});
export const TovioPinnedProposal = Schema.Struct({
  ...TovioProposal.fields,
  revision: Schema.Int,
  commit: TovioDigest,
  base: TovioDigest,
  origin: TovioDigest,
});
export const TovioReview = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.String,
      marker: Schema.String,
      hunks: Schema.optional(
        Schema.Array(Schema.Struct({ sign: Schema.String, text: Schema.String })),
      ),
    }),
  ),
  conflicted: Schema.Array(Schema.String),
});

export const TovioInspectInput = Schema.Union([
  Schema.Struct({ cwd: TrimmedNonEmptyString, operation: Schema.Literals(["lanes", "diff"]) }),
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    operation: Schema.Literal("proposals"),
    target: TovioTarget,
  }),
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    operation: Schema.Literal("review"),
    proposal: TovioProposalId,
  }),
]);
export type TovioInspectInput = typeof TovioInspectInput.Type;

export const TovioLane = Schema.Struct({
  name: Schema.String,
  target: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
});

export const TovioInspectResult = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("lanes"), lanes: Schema.Array(TovioLane) }),
  Schema.Struct({ operation: Schema.Literal("diff"), changes: Schema.Array(Schema.String) }),
  Schema.Struct({
    operation: Schema.Literal("proposals"),
    proposals: Schema.Array(TovioProposal),
  }),
  Schema.Struct({
    operation: Schema.Literal("review"),
    proposal: TovioPinnedProposal,
    review: TovioReview,
    webUrl: Schema.optional(Schema.String),
  }),
]);
export type TovioInspectResult = typeof TovioInspectResult.Type;

export const TovioMutateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("commit"),
      message: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
    }),
    Schema.Struct({
      kind: Schema.Literals(["createLane", "switchLane"]),
      lane: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
    Schema.Struct({ kind: Schema.Literals(["pull", "push"]) }),
    Schema.Struct({
      kind: Schema.Literal("propose"),
      change: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
      target: TovioTarget,
      requestId: Schema.String.check(Schema.isPattern(/^prop:[a-f0-9]{32}$/u)),
    }),
    Schema.Struct({
      kind: Schema.Literal("decide"),
      proposal: TovioPinnedProposal,
      decision: Schema.Literals(["approve", "request-changes"]),
    }),
  ]),
});
export type TovioMutateInput = typeof TovioMutateInput.Type;

export const VcsFreshnessSource = Schema.Literals([
  "live-local",
  "cached-local",
  "cached-remote",
  "explicit-remote",
]);
export type VcsFreshnessSource = typeof VcsFreshnessSource.Type;

export const VcsFreshness = Schema.Struct({
  source: VcsFreshnessSource,
  observedAt: Schema.DateTimeUtc,
  expiresAt: Schema.Option(Schema.DateTimeUtc),
});
export type VcsFreshness = typeof VcsFreshness.Type;

export const VcsDriverCapabilities = Schema.Struct({
  kind: VcsDriverKind,
  supportsWorktrees: Schema.Boolean,
  supportsBookmarks: Schema.Boolean,
  supportsAtomicSnapshot: Schema.Boolean,
  supportsPushDefaultRemote: Schema.Boolean,
  ignoreClassifier: Schema.Literals(["native", "git-compatible-fallback"]),
});
export type VcsDriverCapabilities = typeof VcsDriverCapabilities.Type;

export const VcsRepositoryIdentity = Schema.Struct({
  kind: VcsDriverKind,
  rootPath: TrimmedNonEmptyString,
  metadataPath: Schema.NullOr(TrimmedNonEmptyString),
  freshness: VcsFreshness,
});
export type VcsRepositoryIdentity = typeof VcsRepositoryIdentity.Type;

export const VcsListWorkspaceFilesResult = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  freshness: VcsFreshness,
});
export type VcsListWorkspaceFilesResult = typeof VcsListWorkspaceFilesResult.Type;

export const VcsRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  pushUrl: Schema.Option(TrimmedNonEmptyString),
  isPrimary: Schema.Boolean,
});
export type VcsRemote = typeof VcsRemote.Type;

export const VcsListRemotesResult = Schema.Struct({
  remotes: Schema.Array(VcsRemote),
  freshness: VcsFreshness,
});
export type VcsListRemotesResult = typeof VcsListRemotesResult.Type;

export interface VcsProcessErrorContext {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly argumentCount?: number;
}

export interface VcsProcessSpawnFailure {
  readonly cause: unknown;
}

export interface VcsProcessTimeoutFailure {
  readonly timeoutMs: number;
}

export const VcsProcessExitFailureKind = Schema.Literals([
  "authentication",
  "not-found",
  "rate-limited",
  "command-failed",
]);
export type VcsProcessExitFailureKind = typeof VcsProcessExitFailureKind.Type;

export interface VcsProcessExitFailure {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export class VcsProcessSpawnError extends Schema.TaggedError<VcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to spawn in ${this.operation}: ${this.command} (${this.cwd})`;
  }

  static fromProcessSpawnError(context: VcsProcessErrorContext, error: VcsProcessSpawnFailure) {
    return new VcsProcessSpawnError({
      ...context,
      cause: error.cause,
    });
  }
}

export class VcsProcessExitError extends Schema.TaggedError<VcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    retryable: Schema.optional(Schema.Boolean),
    stderrLength: Schema.optional(NonNegativeInt),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }

  static fromProcessExit(
    context: VcsProcessErrorContext,
    error: VcsProcessExitFailure,
    failureKind: VcsProcessExitFailureKind,
    options?: { readonly retryable?: boolean; readonly notFoundDetail?: string },
  ) {
    const detail =
      failureKind === "authentication"
        ? "Authentication failed."
        : failureKind === "rate-limited"
          ? "API rate limit exceeded."
          : failureKind === "not-found"
            ? (options?.notFoundDetail ?? "VCS resource not found.")
            : "Process exited with a non-zero status.";

    return new VcsProcessExitError({
      ...context,
      exitCode: error.exitCode,
      detail,
      failureKind,
      ...(options?.retryable === true ? { retryable: true } : {}),
      stderrLength: error.stderr.length,
      stderrTruncated: error.stderrTruncated,
    });
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedError<VcsProcessTimeoutError>()(
  "VcsProcessTimeoutError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `VCS process timed out in ${this.operation}: ${this.command} (${this.cwd}) after ${this.timeoutMs}ms`;
  }

  static fromProcessTimeoutError(context: VcsProcessErrorContext, error: VcsProcessTimeoutFailure) {
    return new VcsProcessTimeoutError({
      ...context,
      timeoutMs: error.timeoutMs,
    });
  }
}

const VcsProcessBoundaryErrorFields = {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(NonNegativeInt),
};

export class VcsProcessStdinWriteError extends Schema.TaggedError<VcsProcessStdinWriteError>()(
  "VcsProcessStdinWriteError",
  {
    ...VcsProcessBoundaryErrorFields,
    stdinBytes: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to write ${this.stdinBytes} bytes to stdin in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputReadError extends Schema.TaggedError<VcsProcessOutputReadError>()(
  "VcsProcessOutputReadError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to read ${this.stream} in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputLimitError extends Schema.TaggedError<VcsProcessOutputLimitError>()(
  "VcsProcessOutputLimitError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: NonNegativeInt,
    observedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `VCS process ${this.stream} produced ${this.observedBytes} bytes in ${this.operation}: ${this.command} (${this.cwd}), exceeding the ${this.maxBytes} byte limit`;
  }
}

export class VcsProcessMissingExitCodeError extends Schema.TaggedError<VcsProcessMissingExitCodeError>()(
  "VcsProcessMissingExitCodeError",
  VcsProcessBoundaryErrorFields,
) {
  override get message(): string {
    return `VCS process completed without an exit code in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsRepositoryDetectionError extends Schema.TaggedError<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `VCS repository detection failed in ${this.operation}: ${this.cwd} - ${this.detail}`;
  }
}

export class VcsUnsupportedOperationError extends Schema.TaggedError<VcsUnsupportedOperationError>()(
  "VcsUnsupportedOperationError",
  {
    operation: Schema.String,
    kind: VcsDriverKind,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `VCS operation is unsupported for ${this.kind} in ${this.operation}: ${this.detail}`;
  }
}

export const VcsError = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
export type VcsError = typeof VcsError.Type;
