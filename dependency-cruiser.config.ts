import { defineConfig, DEV_ONLY } from "@avi2dg/checks/dependency-cruiser";

export default defineConfig({
  devOnly: [...DEV_ONLY, "^scripts/"],
  forbidden: [
    {
      name: "panel-imports-package",
      severity: "error",
      comment: "A panel package reaches the others only through @tui-dash/schema and @tui-dash/ui, and the dashboard reaches panels only through the modules the cli hands it.",
      from: { path: "^packages/([^/]+)/", pathNot: "^packages/(cli|schema|ui)/" },
      to: { path: "^packages/", pathNot: ["^packages/$1/", "^packages/(schema|ui)/"] },
    },
    {
      name: "ui-imports-package",
      severity: "error",
      comment: "The ui package draws for every panel, so it reaches no package but @tui-dash/schema.",
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
  ],
});
