import { defineConfig } from "@avi2dg/checks/oxlint";

// Effect does not load in the Herdr App.
// oxlint refuses options in a nested config.
const { options: _rootOnly, ...config } = defineConfig({ effect: false, ignorePatterns: ["app-types/"] });

export default config;
