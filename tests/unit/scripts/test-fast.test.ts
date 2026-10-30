import { expect, test } from "bun:test";
import { keptPaths, touchedE2eFiles } from "../../../scripts/test-fast.ts";
import type { Change } from "../../../node_modules/@avi2dg/checks/src/core/git.ts";

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

test("a deleted path drops out while a renamed path enters under its new name", () => {
  expect(keptPaths([
    written("tests/e2e/session-quota/capture.test.ts"),
    { kind: "deleted", path: "tests/e2e/old.test.ts" },
    { kind: "renamed", from: "tests/e2e/old.test.ts", path: "tests/e2e/new.test.ts", edited: false },
  ])).toEqual(["tests/e2e/session-quota/capture.test.ts", "tests/e2e/new.test.ts"]);
});
