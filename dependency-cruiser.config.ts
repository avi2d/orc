import { defineConfig, DEV_ONLY } from "@avi2dg/checks/dependency-cruiser";

const pkg = "^packages/([^/]+)/src/";
const own = "^packages/$1/src/";
const below = (layer: string, above: string) => ({
  name: layer + "-imports-higher-layer",
  severity: "error" as const,
  comment: "A layer imports only the layers under it, in the order app, widgets, features, entities, shared.",
  from: { path: pkg + layer + "/" },
  to: { path: own + "(" + above + ")(/|\\.ts$)" },
});

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
    below("shared", "app|widgets|features|entities|bin|index"),
    below("entities", "app|widgets|features|bin|index"),
    below("features", "app|widgets|bin|index"),
    below("widgets", "app|bin|index"),
    {
      name: "slice-imports-sibling",
      severity: "error",
      comment: "A widget or feature slice imports no other slice on its own layer.",
      from: { path: pkg + "(widgets|features)/([^/]+)/" },
      to: { path: own + "$2/", pathNot: own + "$2/$3/" },
    },
    {
      name: "slice-internals",
      severity: "error",
      comment: "A slice is entered through its index.ts.",
      from: { path: pkg + "(app|widgets|features|entities|shared)/([^/]+)/" },
      to: { path: own + "(app|widgets|features|entities|shared)/[^/]+/", pathNot: [own + "$2/$3/", own + "(app|widgets|features|entities|shared)/[^/]+/index\\.ts$"] },
    },
    {
      name: "app-imports-slice-internals",
      severity: "error",
      comment: "The app layer enters a slice through its index.ts.",
      from: { path: pkg + "(app/[^/]+|bin|index)\\.ts$" },
      to: { path: own + "(widgets|features|entities|shared)/[^/]+/", pathNot: "/index\\.ts$" },
    },
    {
      name: "layered-imports-unlayered",
      severity: "error",
      comment: "A file inside a layer folder imports no file of its package left outside the layers.",
      from: { path: pkg + "(app|widgets|features|entities|shared)/" },
      to: { path: own, pathNot: own + "(app|widgets|features|entities|shared)/" },
    },
  ],
});
