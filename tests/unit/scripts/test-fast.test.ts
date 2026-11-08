import { expect, test } from "bun:test";
import { cappedWorkerCount, reclaimableBytes, selectFiles, touchedTestFiles, workerCountFor } from "../../../scripts/test-fast.ts";

test("a change touching unit and e2e tests runs those files and nothing else", () => {
  expect(touchedTestFiles([
    "packages/schema/src/source.ts",
    "tests/unit/session-quota/app.test.ts",
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/test-fast.test.ts",
    "tests/fixtures/quota.json",
    "tests/lib/fixtures.ts",
  ])).toEqual([
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/test-fast.test.ts",
    "tests/unit/session-quota/app.test.ts",
  ]);
});

test("helpers and data under the test tree never run as tests, only the test files do", () => {
  expect(touchedTestFiles(["tests/e2e/lib/helper.ts", "tests/unit/lib/helper.ts", "tests/e2e/session-quota/capture.test.ts"])).toEqual([
    "tests/e2e/session-quota/capture.test.ts",
  ]);
});

test("a quarantined path is not a test file the change touches", () => {
  expect(touchedTestFiles(["tests/quarantine/e2e/capture.test.ts"])).toEqual([]);
});

test("a repeated path runs once and the files sort", () => {
  expect(touchedTestFiles([
    "tests/e2e/test-fast.test.ts",
    "tests/unit/session-quota/app.test.ts",
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/session-quota/capture.test.ts",
  ])).toEqual([
    "tests/e2e/session-quota/capture.test.ts",
    "tests/e2e/test-fast.test.ts",
    "tests/unit/session-quota/app.test.ts",
  ]);
});

test("a files narrowing runs the narrowed files, not the directly changed ones", () => {
  expect(selectFiles({ kind: "files", files: ["tests/unit/app.test.ts"] }, ["tests/e2e/other.test.ts"])).toEqual([
    "tests/unit/app.test.ts",
  ]);
});

test("a full narrowing runs only the directly changed tests, not the whole suite", () => {
  expect(selectFiles({ kind: "full", because: "the pull request changes bun.lock, a lockfile" }, [
    "tests/unit/app.test.ts",
  ])).toEqual(["tests/unit/app.test.ts"]);
});

test("a full narrowing with no directly changed test runs nothing, not the suite", () => {
  expect(selectFiles({ kind: "full", because: "the pull request changes bun.lock, a lockfile" }, [])).toEqual([]);
});

test("three or fewer computed workers run unchanged, not reduced", () => {
  expect(cappedWorkerCount(2)).toBe(2);
});

test("more than three computed workers run three, not the computed count", () => {
  expect(cappedWorkerCount(16)).toBe(3);
});

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const MAC_VM_STAT = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
  "Pages free:                                    52285.\n" +
  "Pages active:                                 326890.\n" +
  "Pages inactive:                               313571.\n" +
  "Pages speculative:                             12661.\n" +
  "Pages throttled:                                   0.\n" +
  "Pages wired down:                             250219.\n" +
  "Pages purgeable:                                7522.\n";

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
