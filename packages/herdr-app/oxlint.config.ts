import { defineConfig } from "@avi2dg/checks/oxlint";

// Effect does not load in the Herdr App.
// oxlint refuses options in a nested config.
const { options: _rootOnly, ...config } = defineConfig({
  effect: false,
  overrides: [
    {
      files: ["app-types/**/*.d.ts"],
      rules: {
        "typescript/no-explicit-any": "off",
        "max-lines": "off",
        "max-lines-per-function": "off",
        "max-statements": "off",
        "readability/cognitive-complexity": "off",
        "max-depth": "off"
      }
    }
  ]
});

export default config;
