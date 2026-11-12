import preset from "@avi2dg/checks/stryker.preset.js";

export default { ...preset, mutate: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"] };
