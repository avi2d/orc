---
kind: how-to
---
# Contribute
To run the checks:

1. Run `bun run build` to build the workspace.
1. Run `bun run lint` to lint it.
1. Run `bun run typecheck` to typecheck it.
1. Run `bun run test` to test it.

The secrets gate in `bun run lint` fails a change that adds a term from a private list of host and person names.
The list is a JSON file in the format [checks-secrets](https://github.com/avi2d/checks/blob/main/docs/gates/checks-secrets.md#the-private-pack) reads, with keys such as `hosts` and `names`.
It lives outside orc, at `~/.config/checks/secrets-pack.json`, or wherever `CHECKS_SECRETS_PACK` points.
Lint fails on a machine with no list, so no change skips the gate.
In CI the `CHECKS_SECRETS_PACK` repository secret holds the list.

A panel package reaches another package only through the schema and ui packages, and `bun run lint` refuses any other import.
