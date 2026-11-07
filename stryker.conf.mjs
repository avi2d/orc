import preset from "@avi2dg/checks/stryker.preset.js";

export default {
  ...preset,
  // The runner's preload imports every mutated file, and an entry point runs its program and exits on import.
  mutate: ["packages/*/src/**/*.ts", "!packages/*/src/live/**", "!packages/*/src/*bin.ts"],
};
