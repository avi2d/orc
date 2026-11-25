import { defineConfig } from "@avi2dg/checks/config";

export default defineConfig({
  smoke: ["tests/e2e/retired-name.test.ts"],
  releaseAssets: true,
});
