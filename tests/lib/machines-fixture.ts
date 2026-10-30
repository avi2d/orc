import { Schema } from "effect";
import {
  type Outcome,
  type RemoteReading,
  SessionQuotaReport,
  type SessionQuotaView,
  sessionQuotaViewOf,
} from "@tui-dash/schema";
import { fixture } from "./fixtures";
import { valueOf } from "./outcomes";

const decodeReport = Schema.decodeUnknownSync(SessionQuotaReport);

export const machineReport = (machine: "north" | "south"): SessionQuotaReport =>
  decodeReport(JSON.parse(fixture(`session-quota/${machine}.json`)));

// A machine's --json prints its report on one line, as the remote command hands it over.
export const machineStdout = (machine: "north" | "south", edit: (report: SessionQuotaReport) => SessionQuotaReport = (report) => report): string =>
  `${JSON.stringify(edit(machineReport(machine)))}\n`;

export const machineView = (
  machine: "north" | "south",
  edit: (report: SessionQuotaReport) => SessionQuotaReport = (report) => report,
): SessionQuotaView => valueOf(sessionQuotaViewOf(edit(machineReport(machine)), machine));

type AccountKey = SessionQuotaReport["accounts"][number]["accountKey"];

// Both fixture machines name the shared Claude account work, so a test can respell its key on one of them.
export const claudeKeyed =
  (accountKey: AccountKey) =>
  (report: SessionQuotaReport): SessionQuotaReport => ({
    ...report,
    accounts: report.accounts.map((account) => (account.provider === "claude" ? { ...account, accountKey } : account)),
    windows: report.windows.map((window) =>
      window.account.provider === "claude" ? { ...window, account: { ...window.account, accountKey } } : window,
    ),
  });

export const claudeUnread =
  (detail: string) =>
  (report: SessionQuotaReport): SessionQuotaReport => ({
    ...report,
    accounts: report.accounts.map((account) =>
      account.provider === "claude" ? { ...account, quota: { status: "invalid", detail } } : account,
    ),
  });

export const southReading = (reading: Outcome<SessionQuotaView> = { kind: "ok", value: machineView("south") }): RemoteReading => ({
  name: "south",
  reading,
});
