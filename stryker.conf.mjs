import { readFileSync } from "node:fs";
import preset from "@avi2dg/checks/stryker.preset.js";

// The bun runner's coverage preload imports every mutated file inside the bun test child, and these bin entries run their command at import, so capture-bin.ts exits that child, cli/src/bin.ts starts the dashboard in it and heavy-standin-main.ts sets its exit code.
const binEntries = [
  "packages/cli/src/bin.ts",
  "packages/session-quota/src/capture-bin.ts",
  "packages/run/src/entities/heavy-queue/heavy-standin-main.ts",
];

// The Herdr App supplies herdr, gpui-kit and gpui-base only inside its own runtime, so the tests mock them before importing these files, and the runner's preload imports every mutated file first, which leaves each failed import cached.
const herdrAppSources = "packages/herdr-app/src/**";

// The runner puts every test file in one bun test process, where mock.module keeps the export names of the first mock of a module, so a later file's mock cannot add one and its import fails to link.
const sharesRuntimeMocks = (file) => /mock\.module\("(?:gpui-kit|gpui-base|herdr)"/.test(readFileSync(file, "utf8"));

export default {
  ...preset,
  bun: { ...preset.bun, ...(preset.bun.testFiles === undefined ? {} : { testFiles: preset.bun.testFiles.filter((file) => !sharesRuntimeMocks(file)) }) },
  mutate: ["packages/*/src/**/*.{ts,tsx}", "!packages/*/src/**/*.test.{ts,tsx}", ...binEntries.map((file) => `!${file}`), `!${herdrAppSources}`],
};
