# Project agent memory

This repository holds the orc command and the orc-dash panels it ships beside, and README.md holds what a person reads. VISION.md holds the product direction each change is judged against.

## Checks

- Before a change is done, a worker runs only the test files it added or changed. Build, lint, typecheck and the tests the change reaches are left to validation. `.no-mistakes.yaml` runs the tests the change reaches and [Contribute](docs/contribute.md) lists the full `bun run test` kept for PRs.
- `bun run lint` needs the private secrets pack, as [Contribute](docs/contribute.md) says, and fails on a machine without it.
- A panel package imports another package only through `packages/schema` and `packages/ui`, which `dependency-cruiser.config.ts` holds.
- Tests sit by level under `tests/unit`, `tests/e2e` and `tests/live`.

## Docs

- `packages/run/README.md` ships in the npm package, so it links `docs/run/` by its GitHub URL, never by a relative path.
- Each page under `docs/` declares its `kind` in front matter, as the templates in `node_modules/@avi2dg/checks/dist/templates/` hold.
- `CHANGELOG.md` is the one changelog, and `bun run build` copies it into the run package.
