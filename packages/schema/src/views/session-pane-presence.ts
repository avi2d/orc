import type { Outcome } from "../reading";
import type { LogFile } from "../sessions/ledger";
import { tieFolderOf } from "../sessions/live";
import type { HerdrPane } from "../sources/live-sessions";
import type { LogRoots } from "../sources/session-logs";

export interface PanePresence {
  readonly pane: string;
  readonly status: string | undefined;
  readonly tie: string | undefined;
  readonly machine?: string;
}

export interface HeadlessFolder {
  readonly cwd: string;
  readonly machine?: string;
}

export interface PresenceFields {
  readonly panePresence?: ReadonlyArray<PanePresence>;
  readonly headlessFolders?: ReadonlyArray<HeadlessFolder>;
}

export const presenceFieldsOf = (inputs: PresenceFields): Required<PresenceFields> => ({
  panePresence: inputs.panePresence ?? [],
  headlessFolders: inputs.headlessFolders ?? [],
});

export const presenceOf = (
  panes: Outcome<ReadonlyArray<HerdrPane>>,
  roots: LogRoots,
  files: ReadonlyArray<LogFile>,
  headless: ReadonlyArray<string>,
): Required<PresenceFields> => {
  const knownFiles = new Map(files.map((file) => [file.path, file]));
  const panePresence =
    panes.kind === "ok"
      ? panes.value.map((pane) => ({
          pane: pane.pane_id,
          status: pane.agent_status,
          tie: tieFolderOf(pane, roots, knownFiles),
        }))
      : [];
  return { panePresence, headlessFolders: headless.map((cwd) => ({ cwd })) };
};
