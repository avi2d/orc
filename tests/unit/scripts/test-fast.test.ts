import { expect, test } from "bun:test";
import { keptPaths, reclaimableBytes, touchedE2eFiles, workerCountFor } from "../../../scripts/test-fast.ts";
import type { Change } from "@avi2dg/checks/core/git.ts";

const written = (path: string): Change => ({ kind: "written", path });

test("a change touching unit sources runs no e2e files", () => {
  expect(touchedE2eFiles(["packages/quota/src/panel.ts", "tests/unit/quota/app.test.ts", "package.json"])).toEqual([]);
});

test("a change touching e2e tests runs those files and nothing else", () => {
  expect(touchedE2eFiles([
    "packages/schema/src/source.ts",
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/test-fast.test.ts",
    "tests/unit/session-quota/app.test.ts",
    "tests/fixtures/quota.json",
    "tests/lib/fixtures.ts",
  ])).toEqual(["tests/e2e/session-quota/capture.test.ts", "tests/e2e/test-fast.test.ts"]);
});

test("a quarantined e2e path is not an e2e file the change touches", () => {
  expect(touchedE2eFiles(["tests/quarantine/e2e/capture.test.ts"])).toEqual([]);
});

test("helpers and data under the e2e level never run as tests", () => {
  expect(touchedE2eFiles(["tests/e2e/lib/helper.ts", "tests/e2e/session-quota/capture.test.ts"])).toEqual([
    "tests/e2e/session-quota/capture.test.ts",
  ]);
});

test("a repeated path runs once and the files sort", () => {
  expect(touchedE2eFiles([
    "tests/e2e/test-fast.test.ts",
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/session-quota/capture.test.ts",
  ])).toEqual(["tests/e2e/session-quota/capture.test.ts", "tests/e2e/test-fast.test.ts"]);
});

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const MAC_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    52285.
Pages active:                                 326890.
Pages inactive:                               313571.
Pages speculative:                             12661.
Pages throttled:                                   0.
Pages wired down:                             250219.
Pages purgeable:                                7522.
`;

test("ample memory runs one worker per CPU, not fewer", () => {
  expect(workerCountFor(35 * GiB, 47 * GiB, 16)).toBe(16);
});

test("a second worker costs the increment, so memory for three workers runs three, not four", () => {
  expect(workerCountFor(2348 * MiB, 10 * GiB, 16)).toBe(3);
});

test("more memory than CPUs never adds workers past the CPU count", () => {
  expect(workerCountFor(100 * GiB, 110 * GiB, 4)).toBe(4);
});

test("less memory than one worker still runs one worker, not none", () => {
  expect(workerCountFor(512 * MiB, 8 * GiB, 10)).toBe(1);
});

test("eight gib free on a 47 gib box runs 24 workers on 32 cpus, not seven", () => {
  expect(workerCountFor(8 * GiB, 47 * GiB, 32)).toBe(24);
});

test("five gib free on a 47 gib box runs one worker, not four", () => {
  expect(workerCountFor(5 * GiB, 47 * GiB, 16)).toBe(1);
});

test("macOS counts inactive and speculative pages as reclaimable, not only free ones", () => {
  expect(reclaimableBytes(MAC_VM_STAT)).toBe((52285 + 313571 + 12661) * 16384);
});

test("vm_stat output without a page size gives no figure", () => {
  expect(reclaimableBytes("Pages free: 52285.\n")).toBeUndefined();
});

test("a deleted path drops out while a renamed path enters under its new name", () => {
  expect(keptPaths([
    written("tests/e2e/session-quota/capture.test.ts"),
    { kind: "deleted", path: "tests/e2e/old.test.ts" },
    { kind: "renamed", from: "tests/e2e/old.test.ts", path: "tests/e2e/new.test.ts", edited: false },
  ])).toEqual(["tests/e2e/session-quota/capture.test.ts", "tests/e2e/new.test.ts"]);
});
