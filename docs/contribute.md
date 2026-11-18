---
kind: how-to
---
# Contribute
To run the checks:

1. Run `bun run build` to build the workspace.
1. Run `bun run lint` to lint it.
1. Run `bun run typecheck` to typecheck it.
1. Run `bun run test` to test it.

## Update the command reference

To update the command reference:

1. Run `bun run build` to regenerate `docs/reference/commands.md` from the help text.
1. Commit the regenerated page with the change that changed the help.
1. Run `bun run docs:build` to confirm the site still builds.

The reference page is generated.
Change the help in `packages/run/src/app` and never the page.
The same build regenerates the drawings under `docs/diagrams`.
Change `scripts/diagrams`, and never the drawings.

## Write a docs page

Start with the reader's task or question and give the answer first.
Keep one topic on a page, use short sections with descriptive headings, and move separate details to linked pages.
Keep facts and examples readers need, but remove repetition and vague or promotional language.
Read the rendered page as well as the source, and follow its links.
`bun run docs:check` requires at most 300 words between consecutive headings.
The check does not scan decision records.
The check cannot judge whether the prose is clear, so review the text as well.
Generated references and decision records keep the structure their content needs.

## Preview the docs site

To preview the docs site:

1. Run `bun run docs:dev` to serve the site locally.
1. Open the address the command prints.
1. Read the changed pages.

The base path is `/orc/`, set once in `docs/.vitepress/config.ts`.
For a preview served at the site root, run `DOCS_BASE=/ bun run docs:build`, then `DOCS_BASE=/ bun run docs:preview`.

The secrets gate in `bun run lint` fails a change that adds a term from a private list of host and person names.
The list is a JSON file in the format [checks-secrets](https://github.com/avi2d/checks/blob/main/docs/gates/checks-secrets.md#the-private-pack) reads, with keys such as `hosts` and `names`.
It lives outside orc, at `~/.config/checks/secrets-pack.json`, or wherever `CHECKS_SECRETS_PACK` points.
Lint fails on a machine with no list, so no change skips the gate.
In CI the `CHECKS_SECRETS_PACK` repository secret holds the list.

A panel package reaches another package only through the schema and ui packages, and `bun run lint` refuses any other import.
