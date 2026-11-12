---
topics: [feature-sliced-design, folder-map, layers, slices, dependency-cruiser, lint, run, schema, ui, tasks, monorepo]
governs: [packages/run, packages/schema, packages/ui, packages/tasks, dependency-cruiser.config.ts]
---
# 161. orc lays out its packages by Feature-Sliced Design, adapted to a command-line tool

Date: 2026-11-11

## Status

Accepted. The eight first lint rules are in `dependency-cruiser.config.ts`, and the ninth, `unlayered-file`, and the tenth, `unlayered-file-imports`, land with the last move.

## Context

orc is 16 packages, mostly command-line and library code. Its two largest, `run` with 122 source files and `schema` with 110, have no layering, and every folder in them is a flat list. The captain asked for the Feature-Sliced Design folder map, adapted to orc, before any backlog work. The scout measured every number below on e07e908, the head of main when the scout measured; main is now a376c40.

## The captain's words

> Feature-Sliced Design for orc: the folder map is approved as drawn, the twelve small packages stay one slice each with no layer folders, ui and tasks get purpose folders with no layers, entity slices import each other through index.ts kept free of cycles.

Quoted as firstmate recorded them in the brief of 2026-11-11.

## Decision

The mapping of Feature-Sliced Design onto orc holds as follows.

1. Layers. `run` has five layer folders, `app`, `widgets`, `features`, `entities` and `shared`, and 27 slices. `schema` has `features`, `entities` and `shared`, and 14 slices. A layer imports only the layers below it, in the order app, widgets, features, entities, shared.
2. Entry. A slice is entered only through its `index.ts`. Between packages this already holds through `exports` in each `package.json` and the preset rule `no-deep-imports`.
3. No import between slices of one layer. No feature imports another feature, and no widget imports another widget.
4. Entity slices may import each other through their `index.ts`, and `no-folder-cycle` keeps those imports free of cycles. Feature-Sliced Design forbids the import and adds one extra `@x` file per pair; orc does not.
5. `shared` holds segments, not slices: `shared/lib`, `shared/config`, `shared/process`, `shared/sandbox` and `shared/feeds`. A segment may import another segment in either direction, only through that segment's `index.ts`.
6. Segments inside a slice. `schema` slices keep the folders `contract`, `sources` and `views`. `run` slices stay flat, since they hold 1 to 13 files each.
7. The `app` layer keeps argument parsing and command dispatch in `packages/run/src/app/`. The entry files stay where `package.json`, the build script and `knip.config.ts` name them: `packages/run/src/bin.ts` and `packages/schema/src/index.ts`.
8. `widgets` has one slice, `widgets/beat`, the one place that joins several features in a single pass.
9. The `pages` layer does not apply, since orc has no routed screens. Feature-Sliced Design is silent on tests, so the slice rules read only `packages/*/src`, and root tests reach `run` by file path, since `run` publishes no entry.
10. Layering between packages stays as it is. `schema` sits under `ui`, both sit under the panels, and `cli` and `dashboard` sit on top. The five package rules already in `dependency-cruiser.config.ts` hold this and stay.
11. A package under about 12 source files is one slice, with its `src/index.ts` as its public file, and gets no layer folders. It gets purpose folders once it passes about 12 files, and layers only when it holds more than one user-facing purpose. Twelve packages stay one slice each: `cli` (11 files), `session-quota` (10), `queues` (9), `resources` (8), `ledger` (7), `dashboard` (6), `alerts`, `dispatch` and `quota` (5 each), `herdr-app` (5), and `attention` and `schedules` (3 each).
12. `ui` gets five purpose folders and no layers, since the whole package is the shared drawing library and is one layer already. `tasks` gets two purpose folders, `board` and `sampler`, and no layers.
13. Lint. dependency-cruiser carries every rule, in the existing `dependency-cruiser.config.ts`. No new tool is added, and oxlint and knip do not change. The eight first rules are `shared-imports-higher-layer`, `entities-imports-higher-layer`, `features-imports-higher-layer`, `widgets-imports-higher-layer`, `slice-imports-sibling`, `slice-internals`, `app-imports-slice-internals` and `layered-imports-unlayered`. The ninth, `unlayered-file`, forbids a flat file in `run` or `schema`, and the tenth, `unlayered-file-imports`, forbids a flat file from importing, and both land with the last move, since while flat files remain they report violations.
14. Order of work. Layers move from the bottom up: `shared` first, then `entities`, `features`, `widgets` and `app`. `layered-imports-unlayered` forbids a moved file from importing one not yet moved, which holds that order.

## Consequences

- 260 files move under the layout. Git reads 259 as renames, 88 of them with no line changed.
- Imports inside `run`, `schema`, `ui`, `tasks` and the tests are rewritten, about 1,100 of them. Of those about 725 go through a slice `index.ts`. Only paths into `run` change in the tests. No other package's imports change.
- The entry points stay where they are: `packages/run/src/bin.ts`, each `packages/*/src/index.ts` of the 14 packages that have one, `packages/ui/src/bin-args.ts`, `packages/cli/src/bin.ts` and `packages/session-quota/src/capture-bin.ts`.
- Docs that name a moved path change with it, about 118 lines.

## Evidence

On main at a376c40, the eight first rules report 0 violations over 684 modules cruised, from the same run that reports 0 violations with the rules off. Each rule was checked by a probe file that it flagged, and the probe files were not committed.

## What was considered and rejected

- Feature-Sliced Design's own ban on entity imports between slices, with an extra `@x` file per pair. It lost because it adds files and holds nothing that `no-folder-cycle` does not.
- A `pages` layer. It lost because orc has no routed screens.
- Layer folders in every package. It lost because a folder holding one or two files adds a path and nothing else.
- Segment folders inside `run` slices. It lost because a slice of 1 to 13 files would hold one or two files in a segment folder.
- steiger. It is not adopted. Its shape checks assume the layout as written, so the flat `run` slices and the entity imports would need its rules switched off. This comes from its rule list; it was not run.
- eslint-plugin-boundaries. It is not adopted. It needs ESLint, which this repository does not run, and its rules are the same from-path and to-path rules.
- oxlint's `no-restricted-imports`. It is not adopted. It matches the text of an import, not the file the import resolves to.
