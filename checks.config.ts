import { defineConfig } from "@avi2dg/checks/config";

export default defineConfig({
  smoke: ["tests/e2e/retired-name.test.ts"],
  reach: { "packages/run/src/**": ["tests/e2e/**/*.test.ts"] },
  releaseAssets: true,
});
