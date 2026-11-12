import preset from "@avi2dg/checks/stryker.preset.js";

export default { ...preset, mutate: ["packages/*/src/**/*.{ts,tsx}", "!packages/*/src/**/*.test.{ts,tsx}"] };
