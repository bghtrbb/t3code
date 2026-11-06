import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThreadJson,
  ProviderThreadId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { enabled as tovioEnabled } from "../vcs/TovioVcsDriver.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
      "native-recovery-required",
      "native-turn-active",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "native-turn-active":
        return "Finish or interrupt the active turn before rewinding this TOVIO checkout.";
      case "native-recovery-required":
        return "An earlier TOVIO rewind needs recovery. Check the checkout and provider conversation before resuming this thread.";
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const ProviderThreadJson = Schema.fromJsonString(OrchestrationV2ProviderThreadJson);
const decodeProviderThread = Schema.decodeEffect(ProviderThreadJson);
const encodeProviderThread = Schema.encodeEffect(ProviderThreadJson);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/**
 * The message clients see when a rollback fails. Only a held Git index lock
 * gets its own explanation; other reasons carry internal ids or raw Git
 * output, so they fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (error.reason === "native-recovery-required" || error.reason === "native-turn-active")
    return error.message;
  if (isRuntimePolicyAboveCeilingError(error.cause)) return error.cause.message;
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  return isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL
    ? GIT_INDEX_LOCKED_DETAIL
    : ROLLBACK_FAILED_MESSAGE;
}

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | ThreadCommandExecutor.ThreadCommandExecutor
  | SqlClient.SqlClient
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const sql = yield* SqlClient.SqlClient;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback, staleCheckpoints } =
        context;
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== context.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== context.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetTurn =
                latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
                context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
              if (
                targetAttempt === undefined ||
                targetTurn === undefined ||
                targetTurn.providerThreadId !== providerThread.id
              ) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
                providerThreadId: providerThread.id,
                providerTurnId: targetTurn.id,
                attemptId: targetAttempt.id,
              });
              const message =
                attempt === undefined
                  ? undefined
                  : yield* projections.getRunMessage(input.threadId, attempt.runId);
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
                ...(message === undefined ? {} : { message }),
              };
            });

      const { worktreePath, branch } = context.thread;
      const nativeLocal =
        worktreePath === null &&
        (yield* tovioEnabled) &&
        (yield* checkpoints.supportsLocalRestore(scope.cwd));
      const recoveryRequired = () =>
        new CheckpointRollbackExecutionError({
          reason: "native-recovery-required",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      const readRewind = () =>
        sql<{
          readonly target_checkpoint_id: string;
          readonly source_checkpoint_id: string;
          readonly provider_thread_id: string;
          readonly phase: "files_pending" | "provider_pending" | "provider_done";
          readonly provider_thread_json: string | null;
        }>`SELECT * FROM native_checkpoint_rewind WHERE thread_id = ${input.threadId}`;
      const pendingRewind = worktreePath === null ? (yield* readRewind())[0] : undefined;
      if (
        pendingRewind?.phase === "provider_pending" ||
        (pendingRewind && (!nativeLocal || input.restoreFiles === false))
      ) {
        return yield* recoveryRequired();
      }
      const restoreNativeFiles = nativeLocal && input.restoreFiles !== false;
      const activeRuns = restoreNativeFiles
        ? (yield* projections.getThreadRecords(input.threadId, ["runs"], {
            runStatuses: ["preparing", "starting", "running", "waiting"],
          })).runs
        : [];
      if (activeRuns.length > 0) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "native-turn-active",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      // Recreated only where the server would have made it, as turn start does.
      if (
        worktreePath != null &&
        branch != null &&
        !(yield* fileSystem.exists(worktreePath)) &&
        (yield* isManagedWorktreePath(worktreePath))
      ) {
        const project = yield* projects.get(context.thread.projectId);
        if (Option.isSome(project)) {
          yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
          yield* gitWorkflow.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: branch,
            path: worktreePath,
          });
        }
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(context.thread, scope, {
          fileSystem,
          projections,
          projects,
          path,
          allowLocal: nativeLocal,
        }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const providerSessionId = providerThread.providerSessionId;
      const openSession = Effect.gen(function* () {
        const modelSelection = context.thread.modelSelection;
        const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
          thread: context.thread,
          modelSelection,
        });
        const existingSession = context.providerSession;
        return yield* sessions.open({
          threadId: input.threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        });
      });

      // Rolled-back turns remain in audit history but no longer exist in the provider conversation.
      const rolledBackAttemptIds = new Set(context.rolledBackAttemptIds);
      const providerThreadTurns = context.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );

      const rollbackProvider = Effect.fn("CheckpointRollbackService.rollbackProvider")(function* (
        session: Effect.Success<typeof openSession>,
      ) {
        if (runsToRollback.length === 0) return { providerThread };
        return yield* session.rollbackThread({
          providerThread,
          target: rollbackTarget,
          providerThreadTurns,
        });
      });
      const snapshot = yield* restoreNativeFiles
        ? Effect.gen(function* () {
            const latest = staleCheckpoints.at(-1) ?? checkpoint;
            yield* sql`
          INSERT INTO native_checkpoint_rewind
            (thread_id, target_checkpoint_id, source_checkpoint_id, provider_thread_id, phase)
          VALUES (${input.threadId}, ${checkpoint.id}, ${latest.id}, ${providerThread.id}, 'files_pending')
          ON CONFLICT(thread_id) DO NOTHING
        `;
            const [entry] = yield* readRewind();
            if (
              !entry ||
              entry.target_checkpoint_id !== checkpoint.id ||
              entry.source_checkpoint_id !== latest.id ||
              entry.provider_thread_id !== providerThread.id ||
              entry.phase === "provider_pending"
            ) {
              return yield* recoveryRequired();
            }
            if (entry.phase === "provider_done") {
              if (entry.provider_thread_json === null) return yield* recoveryRequired();
              const restoredThread = yield* decodeProviderThread(entry.provider_thread_json);
              return { providerThread: restoredThread };
            }
            const session = yield* openSession;
            yield* checkpoints.restore({ scope, checkpoint, expectedCurrentCheckpoint: latest });
            yield* sql`UPDATE native_checkpoint_rewind SET phase = 'provider_pending' WHERE thread_id = ${input.threadId}`;
            const restored = yield* rollbackProvider(session).pipe(
              Effect.mapError(recoveryRequired),
            );
            const encoded = yield* encodeProviderThread(restored.providerThread);
            yield* sql`
          UPDATE native_checkpoint_rewind SET phase = 'provider_done', provider_thread_json = ${encoded}
          WHERE thread_id = ${input.threadId}
        `;
            return restored;
          })
        : openSession.pipe(Effect.flatMap(rollbackProvider));

      if (!restoreNativeFiles && input.restoreFiles !== false)
        yield* checkpoints.restore({ scope, checkpoint });
      if (!restoreNativeFiles && staleCheckpoints.length > 0) {
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpoints });
      }

      // Lock against full-row thread writes that could restore the old native session after rollback.
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
            Effect.map(
              ids.allocate.event({ threadId: event.threadId }),
              (id) =>
                ({
                  ...event,
                  id,
                }) as Event,
            );
          const events: Array<OrchestrationV2DomainEvent> = [];
          events.push(
            yield* makeEvent({
              type: "provider-thread.updated",
              threadId: input.threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...snapshot.providerThread,
                lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                updatedAt: now,
              },
            }),
          );
          for (const staleCheckpoint of staleCheckpoints) {
            events.push(
              yield* makeEvent({
                type: "checkpoint.captured",
                threadId: input.threadId,
                ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
                nodeId: staleCheckpoint.nodeId,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: now,
                payload: { ...staleCheckpoint, status: "stale" },
              }),
            );
          }
          for (const run of runsToRollback) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            events.push(
              yield* makeEvent({
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status: "rolled_back", completedAt: now },
              }),
            );
            if (rootNode !== undefined) {
              events.push(
                yield* makeEvent({
                  type: "node.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: { ...rootNode, status: "rolled_back", completedAt: now },
                }),
              );
            }
          }
          yield* eventSink.write({
            events,
            ...(restoreNativeFiles ? { completedNativeRewind: input.threadId } : {}),
          });
        }),
      );
      if (restoreNativeFiles && staleCheckpoints.length > 0) {
        yield* checkpoints
          .deleteStaleRefs({ scope, checkpoints: staleCheckpoints })
          .pipe(Effect.ignore({ log: true }));
      }
    });

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease.
          const thread = yield* projections.getThread(input.threadId);
          if (thread.worktreePath !== null) {
            yield* withWorkspaceLease(path.resolve(thread.worktreePath), execute(input));
          } else if (yield* tovioEnabled) {
            const { scope } = yield* projections.getCheckpointRollbackContext(
              input.threadId,
              input,
            );
            yield* scope
              ? withWorkspaceLease(yield* fileSystem.realPath(scope.cwd), execute(input))
              : execute(input);
          } else {
            yield* execute(input);
          }
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isCheckpointRollbackExecutionError(cause)
                ? cause
                : new CheckpointRollbackExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
