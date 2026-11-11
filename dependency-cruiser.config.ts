import { defineConfig, DEV_ONLY } from "@avi2dg/checks/dependency-cruiser";

export default defineConfig({
  devOnly: [...DEV_ONLY, "^scripts/", "^packages/herdr-app/scripts/"],
  orphans: ["^packages/herdr-app/scripts/"],
  options: { builtInModules: { add: ["bun", "gpui-kit", "gpui-base", "gpui-shell", "herdr"] } },
  forbidden: [
    {
      name: "panel-imports-package",
      severity: "error",
      comment: "A panel package reaches the others only through @avi2dg/orc-schema and @avi2dg/orc-ui, and the dashboard reaches panels only through the modules the cli hands it.",
      from: { path: "^packages/([^/]+)/", pathNot: "^packages/(cli|schema|ui)/" },
      to: { path: "^packages/", pathNot: ["^packages/$1/", "^packages/(schema|ui)/"] },
    },
    {
      name: "herdr-app-imports-package",
      severity: "error",
      comment: "The Herdr App mods import no other workspace package.",
      from: { path: "^packages/herdr-app/" },
      to: { path: "^packages/", pathNot: "^packages/herdr-app/" },
    },
    {
      name: "ui-imports-package",
      severity: "error",
      comment: "The ui package draws for every panel, so it reaches no package but @avi2dg/orc-schema.",
      from: { path: "^packages/ui/" },
      to: { path: "^packages/", pathNot: "^packages/(ui|schema)/" },
    },
    {
      name: "schema-imports-package",
      severity: "error",
      comment: "Every package reads through the schema package, so it reaches no other.",
      from: { path: "^packages/schema/" },
      to: { path: "^packages/", pathNot: "^packages/schema/" },
    },
    {
      name: "test-relative-into-library",
      severity: "error",
      comment: "Root tests import a library package by name. Only the run application, which publishes no entry, is reached by path.",
      from: { path: "^tests/" },
      to: { path: "^packages/", pathNot: "^packages/(run|herdr-app)/", dependencyTypes: ["local"], dependencyTypesNot: ["aliased-workspace"] },
    },
  ],
});
