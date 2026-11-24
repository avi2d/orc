import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { plain, quotaLines } from "@avi2dg/orc-quota";
import { type Block, lineWidth } from "@avi2dg/orc-ui";
import { quotaBlocksOf } from "../../lib/dashboard-fixture";
import { fixture } from "../../lib/fixtures";
import { glanceBlock } from "../../lib/host-fixture";
import { type OrcQuotaFixture, orcQuotaText } from "../../lib/orc-quota";

const now = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const blocksOf = (name: OrcQuotaFixture) => quotaBlocksOf(fixture("quota-axi/full.json"), orcQuotaText(name));

const views = {
  panel: (name: OrcQuotaFixture, width: number): Block => quotaLines(blocksOf(name), width, true, now),
  dashboard: (name: OrcQuotaFixture, width: number): Block => glanceBlock({ blocks: blocksOf(name) }, width, 60),
} as const;

// The account blocks sit between live claude's block and codex's header.
const accountRows = (block: Block): ReadonlyArray<string> => {
  const rows = block.map(plain);
  const start = rows.findIndex((row) => row.startsWith("● account"));
  const end = rows.findIndex((row) => row.startsWith("● codex"));
  if (start === -1 || end < start) throw new Error("no account blocks before codex");
  return rows.slice(start, end).map((row) => row.trimEnd());
};

const headers = (rows: ReadonlyArray<string>) => rows.filter((row) => row.startsWith("●"));

const reasonUnder = (rows: ReadonlyArray<string>, header: string): string =>
  rows
    .slice(rows.indexOf(header) + 1)
    .filter((row, index, below) => !below.slice(0, index + 1).some((earlier) => earlier.startsWith("●")))
    .map((row) => row.trim())
    .join(" ");

for (const [view, draw] of Object.entries(views)) {
  for (const width of [84, 40]) {
    describe(`the ${view} at ${width} columns over orc quota --json`, () => {
      test("names the picked account next run and the one under the 20% floor in full, not under t…", () => {
        const rows = accountRows(draw("main-second", width));
        expect(headers(rows)).toEqual(["● account main · next run", "● account second · under the 20% floor"]);
        expect(rows.filter((row) => row.trim().startsWith("all models")).map((row) => /\d+%/u.exec(row)?.[0])).toEqual(["77%", "12%"]);
      });

      test("leaves a spare account's header bare, not marked next run", () => {
        expect(headers(accountRows(draw("second-spare", width)))).toEqual(["● account main · next run", "● account second"]);
      });

      test("names the 75% floor orc quota reports, not the default 20%", () => {
        expect(headers(accountRows(draw("codex-under-floor", width)))).toContain("● account codex · under the 75% floor");
      });

      test("names an unusable account and keeps every word of its reason inside the width", () => {
        const block = draw("second-unusable", width);
        const rows = accountRows(block);
        expect(headers(rows)).toEqual(["● account main · next run", "● account second · unusable"]);
        expect(reasonUnder(rows, "● account second · unusable")).toBe("its login expired, so sign in to second again");
        expect(block.every((line) => lineWidth(line) <= width)).toBe(true);
      });

      test.each([
        ["second-missing", "● accounts · an account is missing", "the subquo snapshot names no account second, so its account list and the quota accounts differ"],
        ["command-missing", "● accounts · command not installed", "the quota command subquo-not-here is not installed on PATH"],
      ] as const)("draws %s as one accounts block with its headline and its whole reason, not an empty panel", (name, header, reason) => {
        const block = draw(name, width);
        const rows = block.map(plain).map((row) => row.trimEnd());
        expect(rows.filter((row) => row.startsWith("● account"))).toEqual([header]);
        expect(reasonUnder(rows.slice(0, rows.findIndex((row) => row.startsWith("● codex"))), header)).toBe(reason);
        expect(block.every((line) => lineWidth(line) <= width)).toBe(true);
      });
    });
  }
}
