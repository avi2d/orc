---
kind: reference
---
# Images for design work
A design task is a task that [dispatch routing](dispatch-rules.md) puts in the `design` category through `tasks.<id>.category`.
Its worker makes its raster images itself through the `generate-assets` skill.
The worker keeps the design and the code itself, and orc starts no second worker for images.

## Where the skill runs

The run's [Pi](https://pi.dev) loads skills on the host under `--sandbox none`, which every queued task passes.
So the worker finds `generate-assets` in the skills folders of the host's user, `~/.agents/skills/` or `~/.pi/agent/skills/`.
The worker reaches the `winwsl` machine over [ssh](https://www.openssh.com) and uses the ChatGPT login of [Codex](https://github.com/openai/codex) there.
On the maintainer's machines, the skills repository puts `generate-assets` in `~/.agents/skills/`, and `winwsl` is the maintainer's own host with Codex signed in.
The skill has Codex write each image into a scratch folder it makes under `/tmp` on `winwsl`.
The bundled implementer prompt lets the worker write in that folder, though it bars every other write outside the repository.
The worker runs Codex with `gpt-6-astra` first.
It runs `gpt-6.1-sol` only when that run exits nonzero or saves no file.

## Set up the image path

To use the same image path on your machine, set up these things on the host that runs the queued task:

1. Put a `generate-assets` folder with its `SKILL.md` in `~/.agents/skills/`.
2. Make `ssh winwsl` reach a machine where you can run `codex`, for example through a `Host winwsl` entry in `~/.ssh/config`.
3. On that machine, sign Codex in with a ChatGPT plan by running `codex login`.
4. On that machine, put `quota-axi` and [jq](https://jqlang.org) on `PATH`, because the skill reads the weekly allowance with `quota-axi --provider codex --json` piped to `jq`.
5. On that machine, install `python3` with [Pillow](https://python-pillow.org), because the skill derives favicon sizes and cuts status marks with it.

## A low allowance

The skill reads the Codex weekly allowance before each run, against a threshold of 20 percent.
When the reading is below that threshold, the skill tells the worker to stop and tell the person the number.
When the command exits nonzero or prints no number, the skill tells the worker to stop and ask the person.
For either stop, the bundled implementer prompt tells the worker to ask through `orc_ask` with `blocks` set to true instead of ending the step.
When no answer comes in time, a ship run parks with that question, its options and its recommendation.
A scout or task run has no branch to park on, so it ends failed with the question in its end reason.
[Ask with blocking](parked-runs.md#ask-with-blocking) shows both cases.

## Related topics

- [Dispatch rules](dispatch-rules.md)
- [Task kinds](task-kinds.md)
- [Parked runs](parked-runs.md)
- [How orc runs Pi](how-orc-runs-pi.md)
