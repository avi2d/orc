import preset, { unitTestFiles } from "@avi2dg/checks/stryker.preset.js";

export default {
  ...preset,
  // src/bin.ts only starts the orc program, which the unit tests this run loads never start.
  // The runner's preload imports every mutated file, and an entry point runs its program and exits on import.
  mutate: ["src/**/*.ts", "!src/bin.ts"],
  bun: {
    ...preset.bun,
    testFiles: unitTestFiles(),
  },
};
