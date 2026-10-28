import type { SessionQuotaView } from "./session-quota";
import { within } from "./task-resources";

const assessmentUnderPanes = (
  panes: ReadonlyArray<{ readonly folder: string; readonly resting: boolean }>,
  active: ReadonlyArray<string>,
  processesUnknown: boolean,
): ((folder: string) => boolean) => {
  const overlaps = (folder: string) => active.some((cwd) => within(folder, cwd) || within(cwd, folder));
  return (folder) => {
    if (processesUnknown) return false;
    const over = panes.filter((pane) => within(pane.folder, folder));
    return over.length > 0 && over.every((pane) => pane.resting) && !overlaps(folder);
  };
};

const restingAgentStatuses: ReadonlySet<string> = new Set(["idle", "done"]);

export const treeRestsOf = (
  view: SessionQuotaView | undefined,
  machine: string,
  origin: "local" | "remote",
): ((folder: string) => boolean) => {
  const onMachine = (entry: { readonly machine?: string }) =>
    entry.machine === undefined ? origin === "local" : entry.machine === machine;
  const sessionsOnMachine = view?.sessions.filter(onMachine) ?? [];
  const presenceOnMachine = (view?.panePresence ?? []).filter(onMachine);
  const panes = presenceOnMachine.flatMap((pane) =>
    pane.tie === undefined ? [] : [{ folder: pane.tie, resting: restingAgentStatuses.has(pane.status ?? "") }],
  );
  const active = [
    ...sessionsOnMachine.flatMap(({ identity, cwd }) => (identity.kind === "process" && cwd !== undefined ? [cwd] : [])),
    ...(view?.unmatched.filter(onMachine).map((runs) => runs.cwd) ?? []),
    ...((view?.headlessFolders ?? []).filter(onMachine).map((folder) => folder.cwd)),
  ];
  const machineFailed = ((): boolean => {
    if (view === undefined) return false;
    if (view.composition === undefined) return origin === "local" ? view.processes !== undefined : true;
    if (machine === view.composition.local) return view.processes !== undefined;
    const remote = view.composition.remotes.find((entry) => entry.name === machine);
    return remote?.state.kind === "ok" ? remote.state.processes !== undefined : true;
  })();
  return assessmentUnderPanes(panes, active, machineFailed);
};
