import type {
  EnvironmentId,
  TovioInspectInput,
  TovioInspectResult,
  TovioMutateInput,
  TovioStatus,
} from "@t3tools/contracts";
import { useState, useTransition } from "react";
import { Linking, TextInput, View } from "react-native";
import { uuidv4 } from "../../../lib/uuid";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";

export function TovioOverview({
  cwd,
  environmentId,
  status,
  canWrite,
  canReview,
}: {
  cwd: string;
  environmentId: EnvironmentId;
  status: TovioStatus;
  canWrite: boolean;
  canReview: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TovioInspectResult | null>(null);
  const [message, setMessage] = useState("");
  const [lane, setLane] = useState("");
  const [target, setTarget] = useState("main");
  const [change, setChange] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const inspect = useAtomCommand(vcsEnvironment.inspectTovio);
  const mutate = useAtomCommand(vcsEnvironment.mutateTovio);
  const writeDisabled = pending || !canWrite;
  const load = (input: TovioInspectInput) =>
    startTransition(async () => {
      const inspected = await inspect({ environmentId, input });
      setResult(inspected._tag === "Success" ? inspected.value : null);
    });
  const run = (action: TovioMutateInput["action"]) =>
    startTransition(async () => {
      if (action.kind === "decide") setResult(null);
      const mutated = await mutate({ environmentId, input: { cwd, action } });
      if (mutated._tag !== "Success") {
        if (action.kind === "decide") {
          const refreshed = await inspect({
            environmentId,
            input: { cwd, operation: "review", proposal: action.proposal.id },
          });
          if (refreshed._tag === "Success") setResult(refreshed.value);
        }
        return;
      }
      setResult(null);
      if (action.kind === "commit") setMessage("");
      if (action.kind === "createLane") setLane("");
      if (action.kind === "propose") {
        setChange("");
        setRequestId(null);
      }
    });

  return (
    <ListSection>
      <View className="gap-1 px-3 py-2">
        <Text>TOVIO · {status.lane}</Text>
        <Text>Change {status.change ?? "Unborn"}</Text>
        <Text>Lane tip {status.head ?? "No commit"}</Text>
        <Text>
          {status.changes.length} changed · {status.conflicts.length} conflicted
        </Text>
      </View>
      <ListRow
        label="View diff"
        disabled={pending}
        onPress={() => load({ cwd, operation: "diff" })}
      />
      {result?.operation === "diff" && <Text selectable>{result.changes.join("\n")}</Text>}
      <ListRow label="Lanes" disabled={pending} onPress={() => load({ cwd, operation: "lanes" })} />
      {result?.operation === "lanes" &&
        result.lanes.map((entry) => (
          <ListRow
            key={entry.name}
            label={entry.name}
            description={entry.current ? "Current" : "Switch lane"}
            disabled={writeDisabled || entry.current}
            onPress={() => run({ kind: "switchLane", lane: entry.name })}
          />
        ))}
      <TextInput
        accessibilityLabel="New lane"
        placeholder="New lane"
        value={lane}
        onChangeText={setLane}
        className="px-3 py-2 text-foreground"
      />
      <ListRow
        label="Create lane"
        disabled={writeDisabled || !lane.trim()}
        onPress={() => run({ kind: "createLane", lane: lane.trim() })}
      />
      <TextInput
        accessibilityLabel="Commit message"
        placeholder="Commit message"
        value={message}
        onChangeText={setMessage}
        className="px-3 py-2 text-foreground"
      />
      <ListRow
        label="Commit change"
        disabled={writeDisabled || status.clean || !message.trim()}
        onPress={() => run({ kind: "commit", message: message.trim() })}
      />
      <ListRow label="Pull" disabled={writeDisabled} onPress={() => run({ kind: "pull" })} />
      <ListRow label="Push" disabled={writeDisabled} onPress={() => run({ kind: "push" })} />
      {canReview && (
        <>
          <TextInput
            accessibilityLabel="Proposal target lane"
            value={target}
            editable={requestId === null}
            onChangeText={setTarget}
            className="px-3 py-2 text-foreground"
          />
          <ListRow
            label="List Tovio Cloud proposals"
            disabled={pending || !target.trim()}
            onPress={() => load({ cwd, operation: "proposals", target: target.trim() })}
          />
          <TextInput
            accessibilityLabel="Committed change ID"
            placeholder="Committed change ID"
            value={change}
            editable={requestId === null}
            onChangeText={setChange}
            className="px-3 py-2 text-foreground"
          />
          <ListRow
            label={requestId ? "Retry proposal" : "Create proposal"}
            disabled={writeDisabled || !target.trim() || !change.trim()}
            onPress={() => {
              const id = requestId ?? `prop:${uuidv4().replaceAll("-", "")}`;
              setRequestId(id);
              run({ kind: "propose", change: change.trim(), target: target.trim(), requestId: id });
            }}
          />
          {requestId && <Text selectable>{requestId}</Text>}
          {result?.operation === "proposals" &&
            result.proposals.map((proposal) => (
              <ListRow
                key={proposal.id}
                label={proposal.id}
                description={proposal.state}
                disabled={pending}
                onPress={() => load({ cwd, operation: "review", proposal: proposal.id })}
              />
            ))}
          {result?.operation === "review" && (
            <View className="gap-2 px-3 py-2">
              <Text>
                {result.proposal.id} · Revision {result.proposal.revision}
              </Text>
              <Text>Commit {result.proposal.commit}</Text>
              {result.webUrl && (
                <ListRow
                  label="Open in Tovio Cloud"
                  onPress={() => {
                    const url = result.webUrl;
                    if (url?.startsWith("https://")) void Linking.openURL(url);
                  }}
                />
              )}
              {result.review.files.map((file) => (
                <View key={file.path}>
                  <Text>
                    {file.path} · {file.marker}
                  </Text>
                  <Text selectable>
                    {file.hunks?.map((line) => `${line.sign}${line.text}`).join("\n") ??
                      "Content is unavailable to this identity."}
                  </Text>
                </View>
              ))}
              <ListRow
                label="Approve"
                disabled={writeDisabled}
                onPress={() =>
                  run({ kind: "decide", proposal: result.proposal, decision: "approve" })
                }
              />
              <ListRow
                label="Request changes"
                disabled={writeDisabled}
                onPress={() =>
                  run({ kind: "decide", proposal: result.proposal, decision: "request-changes" })
                }
              />
            </View>
          )}
        </>
      )}
    </ListSection>
  );
}
