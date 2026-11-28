---
kind: how-to
---
# Develop the orc Herdr App mods

Use a scratch App to check a mod without driving your own [Herdr App](https://herdr.dev).

## Start a scratch App

1. Create an empty scratch home and its App configuration.
   Run `mkdir -p /tmp/scratch-home/.config/herdr-app && echo '{}' > /tmp/scratch-home/.config/herdr-app/keys.json`.
1. Run `HOME=/tmp/scratch-home orc app install`.
1. Run `HOME=/tmp/scratch-home packages/herdr-app/scripts/with-scratch-app.sh <command>`.

The script starts a separate App and quits the App and core it started.
It refuses your login home and an `HC_SESSION` that does not start with `fm-lab-`.
It sets `SCRATCH_APP_BIN` and `SCRATCH_APP_PID` for the command.
Use `"$SCRATCH_APP_BIN" do <command>` to drive the App or `"$SCRATCH_APP_BIN" shot <file.png>` to capture it.

Set `HERDR_APP_BUNDLE` if the App is not at `/Applications/Herdr.app`.
If herdr-core is outside the usual locations, set `HERDR_CORE_DIRS` to its folder.
The script stops if it cannot find herdr-core or its sockets.

## Recapture the Board screenshots

With the layout installed in a scratch home, run `packages/herdr-app/scripts/capture-board.sh tests/fixtures/herdr-board <output-png>`.
Add `orc-resources`, `orc-agents` or `orc-inbox` as a third argument to capture another tab.
To show a selected Board task, pass `orc-board` and its task id, such as `garden-6`.

The script copies the fixture into the scratch home and reads orc from there.
A file under `replies/` in the fixture stands in for one orc command, named by its arguments joined with `_`.
Every other command runs the installed orc.

- For the Inbox screenshot, run `packages/herdr-app/scripts/capture-board.sh tests/fixtures/herdr-inbox docs/images/herdr-inbox.png orc-inbox`.
- For the Checks screenshot, run `packages/herdr-app/scripts/capture-board.sh tests/fixtures/herdr-checks docs/images/herdr-agents-checks.png orc-agents`.

## Check the design system gallery

Open the Orc layout in your test App and select **Design system** in the top bar.
The gallery opens as a window, not a layout tab.
It reads host theme values and uses sample data for all actions.

1. Search **Examples** for `button.32.primary.enabled`, press the button, and check for a receipt.
   Select `button.32.primary.disabled` and check that it produces no receipt.
1. Search for `field-with-button.ready`.
   Change the sample answer, press Enter, and check that the receipt contains the new text.
   Use **Reset example** to restore the starting answer and clear the receipt.
1. Open `rows.grouped`.
   Fold the first group and check that its run hides while the other group still scrolls.
1. Compare `thread.delivered` and `linked-text.wrapped` with **320 px preview** both on and off.
   The sample link should show its destination in the gallery without opening a browser.
1. Capture **Colours** and the examples in the active theme, then with **Graphite** and **Paper** selected.
   Those choices preview Orc colours only.
   To check native input colour, repeat in test App instances that already use each theme.

Use the story ID, theme name, and preview width in each capture's filename.

## Change the mods

The TypeScript mods are in `packages/herdr-app/mods/`.
After an App update, run `bun scripts/copy-app-types.ts <App version>` in `packages/herdr-app` to refresh the App types.
Run `orc app install` to build and install changes from a checkout.
Run `herdr-app check packages/run/dist/herdr-app/mods/<mod>` for each changed mod.
