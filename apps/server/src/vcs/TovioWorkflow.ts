import {
  type TovioInspectInput,
  type TovioMutateInput,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const resolve = Effect.fn("TovioWorkflow.resolve")(function* (cwd: string) {
    const checkWorkspace = (candidate: string) =>
      knownWorkspaces.assertContains(candidate).pipe(
        Effect.mapError(
          () =>
            new VcsRepositoryDetectionError({
              operation: "TovioWorkflow.resolve",
              cwd,
              detail:
                "TOVIO operations require a registered workspace containing the repository root.",
            }),
        ),
      );
    yield* checkWorkspace(cwd);
    const handle = yield* registry.resolve({ cwd });
    const root = handle.repository.rootPath;
    yield* checkWorkspace(root);
    const driver = handle.driver.tovio;
    if (!driver) {
      return yield* new VcsUnsupportedOperationError({
        operation: "TovioWorkflow.resolve",
        kind: handle.kind,
        detail: "This operation requires TOVIO.",
      });
    }
    return { root, driver };
  });

  return {
    inspect: Effect.fn("TovioWorkflow.inspect")(function* (input: TovioInspectInput) {
      const { root, driver } = yield* resolve(input.cwd);
      return yield* driver.inspect({ ...input, cwd: root });
    }),
    mutate: Effect.fn("TovioWorkflow.mutate")(function* (input: TovioMutateInput) {
      const { root, driver } = yield* resolve(input.cwd);
      yield* withWorkspaceLease(root, driver.mutate({ ...input, cwd: root }));
    }),
  };
});
