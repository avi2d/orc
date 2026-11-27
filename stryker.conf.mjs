import preset from "@avi2dg/checks/stryker.preset.js";

// The bun runner's coverage preload imports every mutated file inside the bun test child, and these bin entries run their command at import, so capture-bin.ts exits that child, cli/src/bin.ts starts the dashboard in it and heavy-standin-main.ts sets its exit code.
const binEntries = [
  "packages/cli/src/bin.ts",
  "packages/session-quota/src/capture-bin.ts",
  "packages/run/src/entities/heavy-queue/heavy-standin-main.ts",
];

// The Herdr App supplies herdr, gpui-kit and gpui-base only inside its own runtime, so the tests mock them before importing these files, and the runner's preload imports every mutated file first, which leaves each failed import cached.
const herdrAppSources = "packages/herdr-app/src/**";

export default {
  ...preset,
  mutate: ["packages/*/src/**/*.{ts,tsx}", "!packages/*/src/**/*.test.{ts,tsx}", ...binEntries.map((file) => `!${file}`), `!${herdrAppSources}`],
};
