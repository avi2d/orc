---
kind: how-to
---
# Show orc in the Herdr App

The `orc` layout gives orc a window in the Herdr App, with a Board, a Resources and an Agents tab.
Install it once, and run `orc app install` again after each orc upgrade to pick up the new mods.
That is the only step after an upgrade: `orc app install` builds the mods from the checkout itself, so `bun run build` is not needed.

## Before you begin

- The Herdr App, run at least once so that `~/.config/herdr-app` exists.
- `orc` on the `PATH` of your login shell, since the mods run it through the App.
- `orc-dash` on that `PATH` too, for the Resources tab.

## Install the layout

To install the layout:

1. Run `orc app install`.
1. Run `herdr-app do layout.switch '{"name":"orc"}'`, or press the `layout.switch` key until the `orc` layout shows.
   Check `keys.json` for your `layout.switch` binding.

`orc app install` copies the mods `orc-tabs`, `orc-board`, `orc-resources` and `orc-agents` into `~/.config/herdr-app/mods/`.
It copies `orc.json` and its preview `orc.svg` into `~/.config/herdr-app/layouts/`.
It adds `cmd-1`, `cmd-2` and `cmd-3` to the `layout:orc` section of `~/.config/herdr-app/keys.json`.
A key you already set in that section stays, and the command prints it as skipped.
The command writes only names that start with `orc`, so Herdr's own mods and layouts stay as they are.

## Read the tabs

| Tab | Key | What it shows |
| --- | --- | --- |
| Board | `cmd-1` | The number of tasks in `orc backlog --json` |
| Resources | `cmd-2` | The account names in `orc-dash snapshot --json --only quota` |
| Agents | `cmd-3` | The number of runs in `orc runs --json` |

Board and Agents read again every 15 seconds, and Resources every minute.
When a command fails or prints a document the tab cannot read, the tab shows the command and why.
Use your `layout.switch` key to go back to your own layout.

## Change the mods

The mods are TypeScript in `packages/herdr-app/mods/`, checked against the App's `gpui-kit.d.ts` and `herdr.d.ts`.
The copies of those two files sit in `packages/herdr-app/app-types/`, in a folder named for the App version they came from.
The copies hold no comments, because the comment gate in `bun run lint` refuses the App's doc blocks.
The copy script wraps `herdr.d.ts` in an ambient module for workspace typechecking.
An interface that extends an `import(...)` type extends a local alias because the dependency-cruiser parser refuses that form.
After the App updates, run `bun scripts/copy-app-types.ts <App version>` in `packages/herdr-app` to copy the new files from `~/.config/herdr-app`.
`bun run build` bundles each mod to one `main.js` and copies the result into `packages/run/dist/herdr-app/`.
`orc app install` writes that same folder before it copies from it, when the checkout has the sources, so changing a mod needs only `orc app install`.
A package install ships the built folder and no sources, so `orc app install` copies that folder as it is.
Run `herdr-app check packages/run/dist/herdr-app/mods/<mod>` on each mod you change.

## Related topics

- [The orc-dash dashboard](dash.md)
- [Contribute](contribute.md)
