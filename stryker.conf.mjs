import preset from "@avi2dg/checks/stryker.preset.js";

export default {
  ...preset,
  mutate: ["packages/*/src/**/*.ts", "!packages/*/src/live/**", "!packages/*/src/*bin.ts"],
};
