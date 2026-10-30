import preset, { unitTestFiles } from "@avi2dg/checks/stryker.preset.js";

export default {
  ...preset,
  // src/live and the src/*bin.ts entry points only run real processes and the real terminal, which the unit tests this run loads never start.
  // The runner's preload imports every mutated file, and an entry point runs its program and exits on import.
  // The unit suite runs 120s raw, past the preset 90s dry-run budget.
  dryRunTimeoutMinutes: 10,
  mutate: ["packages/*/src/**/*.ts", "!packages/*/src/live/**", "!packages/*/src/*bin.ts"],
  bun: {
    ...preset.bun,
    timeout: 300000,
    testFiles: unitTestFiles(),
  },
};
