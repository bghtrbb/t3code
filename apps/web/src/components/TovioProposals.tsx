import type { EnvironmentId, TovioInspectResult } from "@t3tools/contracts";
import { useState, useTransition } from "react";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function TovioProposals({
  cwd,
  environmentId,
  canWrite,
}: {
  cwd: string;
  environmentId: EnvironmentId;
  canWrite: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState("main");
  const [change, setChange] = useState("");
  const [list, setList] = useState<Extract<TovioInspectResult, { operation: "proposals" }> | null>(
    null,
  );
  const [review, setReview] = useState<Extract<TovioInspectResult, { operation: "review" }> | null>(
    null,
  );
  const [request, setRequest] = useState<{ id: string; change: string; target: string } | null>(
    null,
  );
  const inspect = useAtomCommand(vcsEnvironment.inspectTovio);
  const mutate = useAtomCommand(vcsEnvironment.mutateTovio);

  const load = async (lane: string) => {
    const result = await inspect({
      environmentId,
      input: { cwd, operation: "proposals", target: lane },
    });
    setList(
      result._tag === "Success" && result.value.operation === "proposals" ? result.value : null,
    );
  };
  const loadReview = async (proposal: string) => {
    setReview(null);
    const result = await inspect({
      environmentId,
      input: { cwd, operation: "review", proposal },
    });
    if (result._tag === "Success" && result.value.operation === "review") setReview(result.value);
  };
  const propose = () =>
    startTransition(async () => {
      const attempted = request ?? {
        id: `prop:${randomUUID().replaceAll("-", "")}`,
        change: change.trim(),
        target: target.trim(),
      };
      setRequest(attempted);
      const result = await mutate({
        environmentId,
        input: {
          cwd,
          action: {
            kind: "propose",
            change: attempted.change,
            target: attempted.target,
            requestId: attempted.id,
          },
        },
      });
      if (result._tag === "Success") {
        setRequest(null);
        setChange("");
      }
      await load(attempted.target);
    });
  const decide = (decision: "approve" | "request-changes") => {
    if (!review) return;
    const { proposal } = review;
    startTransition(async () => {
      setReview(null);
      const result = await mutate({
        environmentId,
        input: { cwd, action: { kind: "decide", proposal, decision } },
      });
      await load(proposal.target);
      if (result._tag !== "Success") await loadReview(proposal.id);
    });
  };

  return (
    <details className="space-y-2">
      <summary>Tovio Cloud proposals</summary>
      <div className="flex items-center gap-1">
        <Input
          aria-label="Proposal target lane"
          value={target}
          disabled={request !== null}
          onChange={(event) => setTarget(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={pending || !target.trim()}
          onClick={() => startTransition(() => load(target.trim()))}
        >
          List proposals
        </Button>
      </div>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (canWrite && !pending && change.trim() && target.trim()) propose();
        }}
      >
        <Input
          aria-label="Committed change ID"
          placeholder="Committed change ID"
          value={change}
          disabled={request !== null}
          onChange={(event) => setChange(event.target.value)}
        />
        <Button
          size="xs"
          type="submit"
          disabled={!canWrite || pending || !change.trim() || !target.trim()}
        >
          {request ? "Retry proposal" : "Create proposal"}
        </Button>
      </form>
      {request && <p className="break-all">Proposal request {request.id}</p>}
      {list?.proposals.map((proposal) => (
        <div key={proposal.id} className="flex items-center justify-between gap-2">
          <span className="break-all">
            {proposal.id} · {proposal.state}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => startTransition(() => loadReview(proposal.id))}
          >
            Review
          </Button>
        </div>
      ))}
      {list?.proposals.length === 0 && <p>No proposals for this lane.</p>}
      {review && (
        <div className="space-y-2">
          <p className="break-all">
            {review.proposal.id} · Revision {review.proposal.revision}
          </p>
          <p className="break-all text-muted-foreground">Commit {review.proposal.commit}</p>
          {review.webUrl && (
            <a href={review.webUrl} target="_blank" rel="noreferrer">
              Open in Tovio Cloud
            </a>
          )}
          {review.review.files.map((file) => (
            <details key={file.path}>
              <summary className="break-all">
                {file.path} · {file.marker}
              </summary>
              {file.hunks ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                  {file.hunks.map((line) => `${line.sign}${line.text}`).join("\n")}
                </pre>
              ) : (
                <p>Content is unavailable to this identity.</p>
              )}
            </details>
          ))}
          <div className="flex flex-wrap gap-1">
            <Button size="xs" disabled={!canWrite || pending} onClick={() => decide("approve")}>
              Approve
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || pending}
              onClick={() => decide("request-changes")}
            >
              Request changes
            </Button>
          </div>
        </div>
      )}
    </details>
  );
}
