import type {
  EnvironmentId,
  TovioInspectResult,
  TovioMutateInput,
  TovioStatus,
} from "@t3tools/contracts";
import { useState, useTransition } from "react";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { TovioProposals } from "./TovioProposals";

export function TovioActionsControl({
  cwd,
  environmentId,
  status,
  canWrite,
  showActions,
  showChanges,
}: {
  cwd: string;
  environmentId: EnvironmentId;
  status: TovioStatus;
  canWrite: boolean;
  showActions: boolean;
  showChanges: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [inspection, setInspection] = useState<TovioInspectResult | null>(null);
  const [message, setMessage] = useState("");
  const [lane, setLane] = useState("");
  const inspect = useAtomCommand(vcsEnvironment.inspectTovio);
  const mutate = useAtomCommand(vcsEnvironment.mutateTovio);
  const disabled = !canWrite || pending;

  const load = (operation: "lanes" | "diff") =>
    startTransition(async () => {
      const result = await inspect({ environmentId, input: { cwd, operation } });
      if (result._tag === "Success") setInspection(result.value);
    });
  const run = (action: TovioMutateInput["action"]) =>
    startTransition(async () => {
      const result = await mutate({ environmentId, input: { cwd, action } });
      if (result._tag !== "Success") return;
      setInspection(null);
      if (action.kind === "commit") setMessage("");
      if (action.kind === "createLane") setLane("");
    });

  return (
    <section className="space-y-2 px-2 py-1.5 text-xs" aria-label="TOVIO source control">
      <p className="font-medium">TOVIO · {status.lane}</p>
      <dl className="space-y-1 break-all text-muted-foreground">
        <div>
          <dt className="inline">Change </dt>
          <dd className="inline">{status.change ?? "Unborn"}</dd>
        </div>
        <div>
          <dt className="inline">Lane tip </dt>
          <dd className="inline">{status.head ?? "No commit"}</dd>
        </div>
      </dl>
      {status.behind_tip && <p>The working copy is behind the lane tip.</p>}
      {showChanges && (
        <div className="space-y-1">
          <p>
            {status.changes.length} changed · {status.conflicts.length} conflicted
          </p>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => load("diff")}>
            View diff
          </Button>
          {inspection?.operation === "diff" && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
              {inspection.changes.join("\n")}
            </pre>
          )}
        </div>
      )}
      {showActions && (
        <>
          <div className="flex flex-wrap gap-1">
            <Button size="xs" variant="outline" disabled={pending} onClick={() => load("lanes")}>
              Lanes
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => run({ kind: "pull" })}
            >
              Pull
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => run({ kind: "push" })}
            >
              Push
            </Button>
          </div>
          {inspection?.operation === "lanes" && (
            <div className="space-y-1">
              {inspection.lanes.map((entry) => (
                <div className="flex items-center justify-between gap-2" key={entry.name}>
                  <span>{entry.name}</span>
                  {entry.current ? (
                    <span>Current</span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => run({ kind: "switchLane", lane: entry.name })}
                    >
                      Switch
                    </Button>
                  )}
                </div>
              ))}
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!disabled && lane.trim()) run({ kind: "createLane", lane: lane.trim() });
                }}
              >
                <Input
                  aria-label="New lane"
                  placeholder="New lane"
                  value={lane}
                  onChange={(event) => setLane(event.target.value)}
                />
                <Button size="xs" type="submit" disabled={disabled || !lane.trim()}>
                  Create lane
                </Button>
              </form>
            </div>
          )}
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && !status.clean && message.trim())
                run({ kind: "commit", message: message.trim() });
            }}
          >
            <Input
              aria-label="Commit message"
              placeholder="Commit message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <Button size="xs" type="submit" disabled={disabled || status.clean || !message.trim()}>
              Commit change
            </Button>
          </form>
          <TovioProposals cwd={cwd} environmentId={environmentId} canWrite={canWrite && !pending} />
        </>
      )}
    </section>
  );
}
