import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import { composedSessionQuota, type SessionQuotaView, sessionQuotaViewOf } from "@tui-dash/schema";
import { flagLines, sessionLines } from "@tui-dash/session-quota";
import { blockDocument, frameText, lineWidth, plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { claudeUnread, machineReport, machineView, southReading } from "../../lib/machines-fixture";
import { valueOf } from "../../lib/outcomes";

const refused = "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused";

const composed = (): SessionQuotaView => composedSessionQuota(machineView("north"), "north", [southReading()]);

const failed = (): SessionQuotaView =>
  composedSessionQuota(machineView("north"), "north", [southReading({ kind: "unreachable", reason: refused })]);

const stale = (): SessionQuotaView =>
  composedSessionQuota(machineView("north"), "north", [
    southReading({ kind: "ok", value: { ...machineView("south"), now: DateTime.makeUnsafe("2026-10-16T11:50:00Z") } }),
  ]);

const unreadable = (): SessionQuotaView =>
  composedSessionQuota(machineView("north"), "north", [southReading({ kind: "invalid", issue: "the output is not JSON" })]);

const localQuotaFailed = (): SessionQuotaView =>
  composedSessionQuota(
    { ...machineView("north"), quota: { kind: "unreachable", reason: "quota-axi exited 1" }, accounts: [] },
    "north",
    [southReading()],
  );

const samePaneView = (machine: "north" | "south"): SessionQuotaView => {
  const report = machineReport(machine);
  const sessions = report.sessions.map((session) => (session.pane === "w1" ? { ...session, pane: "w1A:p2" } : session));
  return valueOf(sessionQuotaViewOf({ ...report, sessions }, machine));
};

const samePanes = (local = "local", remote = "remote"): SessionQuotaView =>
  composedSessionQuota(samePaneView("north"), local, [{ name: remote, reading: { kind: "ok", value: samePaneView("south") } }]);

const longPrefixes = (): SessionQuotaView => samePanes("east-home", "east-work");

const rendered = (view: SessionQuotaView, width: number) => {
  const rows = sessionLines(view, width, 8);
  return Effect.runPromise(frameText(blockDocument(rows), width, rows.length + 1));
};

const normalize = (frame: string): string =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd();

const textOf = (view: SessionQuotaView, width: number): string => sessionLines(view, width).map(plain).join("\n");

describe("the composed session panel, against its pinned screens of two invented machines", () => {
  test("renders the reviewed 84 column screen through OpenTUI", async () => {
    expect(await rendered(composed(), 84)).toBe(normalize(fixture("screens/session-quota-composed-84x17.txt")));
  });

  test("renders the reviewed 40 column screen through OpenTUI", async () => {
    expect(await rendered(composed(), 40)).toBe(normalize(fixture("screens/session-quota-composed-40x26.txt")));
  });

  test("renders the reviewed 40 column screen of a failed remote through OpenTUI", async () => {
    expect(await rendered(failed(), 40)).toBe(normalize(fixture("screens/session-quota-remote-failed-40x19.txt")));
  });
});

describe("the composed session panel at every width from 30 to 120 columns", () => {
  const widths = Array.from({ length: 91 }, (_, index) => 30 + index);
  const views = {
    composed: composed(),
    failed: failed(),
    stale: stale(),
    unreadable: unreadable(),
    localQuotaFailed: localQuotaFailed(),
    samePanes: samePanes(),
    longPrefixes: longPrefixes(),
  };

  test("keeps every row inside the width", () => {
    for (const view of Object.values(views)) {
      for (const width of widths) {
        for (const line of sessionLines(view, width)) expect(lineWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("says which machines' logs the estimates come from, and that they stay upper bounds and never quota", () => {
    for (const width of widths) {
      const together = textOf(views.composed, width).replaceAll("\n", " ");
      for (const phrase of ["estimates from north and south logs", "upper bounds", "never quota"]) expect(together).toContain(phrase);
      expect(textOf(views.failed, width).replaceAll("\n", " ")).toContain("estimates from north logs");
    }
  });

  test("names each session row's machine wherever the row has room, since both machines name a pane w1", () => {
    for (const width of widths.filter((columns) => columns >= 36)) {
      const rows = textOf(views.composed, width)
        .split("\n")
        .filter((row) => /^[●○⚑] .*%/u.test(row));
      expect(rows.length).toBe(5);
      for (const row of rows) expect(row).toMatch(/^[●○⚑] (north|south) /u);
    }
  });

  test("keeps a machine tag that tells two rows of the same pane id apart, down to 30 columns", () => {
    const machineOf = (row: string): string | undefined =>
      ["local", "remote"].find((name) => name.startsWith(row.slice(2).split(" ")[0] ?? "-"));
    for (const width of widths) {
      const rows = textOf(views.samePanes, width)
        .split("\n")
        .filter((row) => /^[●○⚑] /u.test(row) && row.includes("w1A:p2"));
      expect(new Set(rows.map(machineOf))).toEqual(new Set(["local", "remote"]));
      const flag = flagLines(views.samePanes, width, 40).map(plain).find((line) => line.startsWith("⚑"));
      expect([flag?.includes("w1A:p2"), flag === undefined ? undefined : machineOf(flag)]).toEqual([true, "remote"]);
    }
  });

  test("cuts an east- machine tag sharing a long prefix to keep the pane id whole inside the width-minus-22 label column", () => {
    for (const width of widths) {
      const label = width - 22;
      const rows = textOf(views.longPrefixes, width)
        .split("\n")
        .filter((row) => /^[●○⚑] /u.test(row) && row.includes("w1A:p2"));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.slice(2, 2 + label).trimEnd().endsWith("w1A:p2")).toBe(true);
        expect(row.slice(2 + label, 7 + label)).toMatch(/^ *(\d+%|<1%)$/u);
      }
      expect(new Set(rows.map((row) => row.slice(2).split(" ")[0]))).toHaveProperty("size", 2);
    }
  });

  test("names the whole session-quota-composed-json command for the flags that do not fit, within the rows it has", () => {
    const view = views.composed;
    const tripled = { ...view, accounts: [...view.accounts, ...view.accounts, ...view.accounts] };
    for (const width of widths) {
      const caption = flagLines(tripled, width, 40).map(plain).findIndex((line) => line.startsWith("⚑"));
      const lines = flagLines(tripled, width, caption + 2).map(plain);
      expect(lines.length).toBeLessThanOrEqual(caption + 2);
      const pointer = lines.slice(lines.findIndex((line) => /^\+\d/u.test(line)));
      expect(pointer.join(" ")).toMatch(/^\+[56] .*bun run session-quota-composed-json$/u);
    }
  });
});

describe("the composed session panel's notes", () => {
  test("says plainly that a remote that failed leaves this machine's shares alone, with the reason", () => {
    const text = textOf(failed(), 120);
    expect(text).toContain("! south unreachable, so shares count north alone");
    expect(text).toContain(refused);
  });

  test("shows the remote's accounts and flag when this machine's quota reading fails, and warns that calls on quota-axi's accounts are not counted", () => {
    const text = textOf(localQuotaFailed(), 120);
    expect(text).toContain("! north: no quota-axi reading, so calls on the accounts it reads are not counted");
    expect(text).toContain("● claude work");
    expect(text).toMatch(/^⚑ south /mu);
    expect(flagLines(localQuotaFailed(), 120, 10).map(plain).filter((line) => line.startsWith("⚑ south"))).toHaveLength(1);
  });

  test("shows this machine's quota failure in place of the panel when no machine has an account left", () => {
    const view = composedSessionQuota(
      { ...machineView("north"), quota: { kind: "unreachable", reason: "quota-axi exited 1" }, accounts: [] },
      "north",
      [southReading({ kind: "unreachable", reason: refused })],
    );
    const text = textOf(view, 120);
    expect(text).toContain("quota-axi exited 1");
    expect(text).not.toContain("no quota reading");
  });

  test("names the machine and account it could not read, with the reason, beside the other machine's windows", () => {
    const view = composedSessionQuota(machineView("north", claudeUnread("quota-axi gave claude work no windows")), "north", [southReading()]);
    const text = textOf(view, 120);
    expect(text).toContain("! north: no claude work reading, so its calls are not counted");
    expect(text).toContain("quota-axi gave claude work no windows");
    expect(text).toMatch(/^⚑ south /mu);
  });

  test("gives a stale remote's age", () => {
    expect(textOf(stale(), 120)).toContain("! south answered 10m ago, so shares count north alone");
  });

  test("names a remote whose report it could not read, with the issue", () => {
    const text = textOf(unreadable(), 120);
    expect(text).toContain("! south sent no readable report, so shares count north alone");
    expect(text).toContain("the output is not JSON");
  });

  test("names the machine whose headless runs share a log folder", () => {
    expect(textOf(composed(), 120)).toContain("! south: pids 5150 5151 share pi logs in ~/work/api");
  });

  test("names a window another machine read in a different cycle", () => {
    expect(textOf(composed(), 120)).toContain("5h window 0pp used · none logged on north or south · south read another cycle");
  });

  test("points a flag that does not fit at the composed report", () => {
    const view = composedSessionQuota(machineView("north"), "north", [southReading()]);
    const doubled = { ...view, accounts: [...view.accounts, ...view.accounts] };
    expect(flagLines(doubled, 84, 2).map(plain).at(-1)).toBe("+4 more flags, see bun run session-quota-composed-json");
  });
});
