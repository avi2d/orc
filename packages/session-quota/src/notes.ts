import type { Composition, Failed, FailedAccount, RemoteMachine, SessionQuotaView } from "@tui-dash/schema";
import { type Block, countdown, ellipsize, type Line, secondsBetween, span, widthOf, wrapParts } from "@tui-dash/ui";

export const listed = (names: ReadonlyArray<string>, conjunction: string): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1) ?? ""}`;

export const combinedNames = (composition: Composition): ReadonlyArray<string> => [
  composition.local,
  ...composition.remotes.flatMap(({ name, state }) => (state.kind === "ok" ? [name] : [])),
];

// Another machine's accounts stand when this machine's quota reading fails, so the failure fills the panel only when no account is left.
export const panelFailure = (view: SessionQuotaView): Failed | undefined =>
  view.accounts.length === 0 ? view.quota : undefined;

interface NotePart {
  readonly joiner: string;
  readonly text: string;
}

// The folder is what a reader acts on, so the note breaks between its parts rather than ellipsizing the folder.
const noteTexts = (parts: ReadonlyArray<NotePart>, width: number): ReadonlyArray<string> =>
  parts.reduce<ReadonlyArray<string>>((lines, { joiner, text }) => {
    const last = lines.at(-1);
    if (last === undefined) return [text];
    const joined = last + joiner + text;
    return widthOf(joined) <= (lines.length === 1 ? width : width - 2) ? [...lines.slice(0, -1), joined] : [...lines, text];
  }, []);

const unmatchedNotes = (view: SessionQuotaView, width: number): Block =>
  view.unmatched.flatMap((runs) => {
    const one = runs.pids.length === 1;
    const parts = [
      { joiner: "", text: `! ${machinePrefix(runs.machine)}${one ? "pid" : "pids"} ${runs.pids.join(" ")}` },
      { joiner: " ", text: `${one ? "shares" : "share"} ${runs.harness} logs` },
      { joiner: " ", text: `in ${runs.place}` },
      { joiner: ", ", text: "so those logs read as ended" },
    ];
    return noteTexts(parts, width).map(
      (text, index): Line => [span(index === 0 ? ellipsize(text, width) : `  ${ellipsize(text, width - 2)}`, "warning")],
    );
  });

const machinePrefix = (machine: string | undefined): string => (machine === undefined ? "" : `${machine}: `);

const warningLines = (parts: ReadonlyArray<string>, width: number): Block =>
  wrapParts(parts, width, ", ").map((text, index): Line => [
    span(index === 0 ? ellipsize(text, width) : `  ${ellipsize(text, width - 2)}`, "warning"),
  ]);

interface MachineSources {
  readonly machine: string | undefined;
  readonly quota: Failed | undefined;
  readonly panes: Failed | undefined;
  readonly processes: Failed | undefined;
}

// The harness logs still read the accounts they cover, so a failed quota-axi read loses only the calls on the accounts it reads.
const quotaNote = (machine: string | undefined, quota: Failed, width: number): Block => [
  ...warningLines([`! ${machinePrefix(machine)}no quota-axi reading`, "so calls on the accounts it reads are not counted"], width),
  ...detailLines(failureDetail(quota), width),
];

const machineNotes = ({ machine, quota, panes, processes }: MachineSources, width: number): Block => [
  ...(quota === undefined ? [] : quotaNote(machine, quota, width)),
  ...[
    panes === undefined ? undefined : ["herdr gave no panes", "so live panes read as ended"],
    processes === undefined ? undefined : ["no process table", "so headless runs read as ended"],
  ].flatMap((note) =>
    note === undefined ? [] : warningLines([`! ${machinePrefix(machine)}${note[0] ?? ""}`, ...note.slice(1)], width),
  ),
];

const detailRoom = 2;

const detailLines = (detail: string, width: number): Block => {
  const lines = wrapParts(detail.split(/\s+/), width - 2, " ");
  const kept = [...lines.slice(0, detailRoom - 1), lines.slice(detailRoom - 1).join(" ")].filter((text) => text !== "");
  return kept.map((text) => [span(`  ${ellipsize(text, width - 2)}`, "muted")]);
};

// A remote that adds nothing leaves this machine's upper bounds, and the note says so beside why.
const remoteNotes = (composition: Composition, now: SessionQuotaView["now"], width: number): Block =>
  composition.remotes.flatMap(({ name, state }: RemoteMachine): Block => {
    const alone = `so shares count ${listed(combinedNames(composition), "and")} alone`;
    switch (state.kind) {
      case "ok":
        return machineNotes({ machine: name, ...state }, width);
      case "stale":
        return warningLines([`! ${name} answered ${countdown(secondsBetween(state.generatedAt, now))} ago`, alone], width);
      case "unreachable":
        return [...warningLines([`! ${name} unreachable`, alone], width), ...detailLines(state.reason, width)];
      case "invalid":
        return [...warningLines([`! ${name} sent no readable report`, alone], width), ...detailLines(state.issue, width)];
    }
  });

const failureDetail = (failure: Failed): string => (failure.kind === "unreachable" ? failure.reason : failure.issue);

const failedAccountNotes = (failed: ReadonlyArray<FailedAccount>, width: number): Block =>
  failed.flatMap(({ machine, account, failure }) => [
    ...warningLines([`! ${machine}: no ${account.title} reading`, "so its calls are not counted"], width),
    ...detailLines(failureDetail(failure), width),
  ]);

export const sourceNotes = (view: SessionQuotaView, width: number): Block => [
  ...(view.composition === undefined ? [] : remoteNotes(view.composition, view.now, width)),
  ...failedAccountNotes(view.composition?.failedAccounts ?? [], width),
  ...machineNotes(
    {
      machine: view.composition?.local,
      quota: panelFailure(view) === undefined ? view.quota : undefined,
      panes: view.panes,
      processes: view.processes,
    },
    width,
  ),
  ...unmatchedNotes(view, width),
];
