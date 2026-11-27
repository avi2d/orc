---
kind: reference
---
# Images for design work
A design task's worker makes its raster images itself through the `generate-assets` skill.
The worker keeps the design and the code itself, and orc starts no second worker for images.

## Where the skill runs

The worker loads that skill from the user's skills folder, because the run's [Pi](https://pi.dev) loads skills on the host under `--sandbox none`, which every queued task passes.
The worker reaches the `winwsl` machine over [ssh](https://www.openssh.com) and uses the ChatGPT login of [Codex](https://github.com/openai/codex) there.
The skill has Codex write each image into a scratch folder it makes under `/tmp` on `winwsl`.
The bundled implementer prompt lets the worker write in that folder, though it bars every other write outside the repository.
The worker runs Codex with `gpt-6-astra` first.
It runs `gpt-6.1-sol` only when that run exits nonzero or saves no file.

## A low allowance

The skill reads the Codex weekly allowance before each run, against a threshold of 20 percent.
When the reading is below that threshold, the skill tells the worker to stop and tell the person the number.
When the command exits nonzero or prints no number, the skill tells the worker to stop and ask the person.
For either stop, the bundled implementer prompt tells the worker to ask through `orc_ask` instead of ending the step.
The run then parks with that question, its options and its recommendation, as [A worker question](parked-runs.md#a-worker-question) shows.

## Related topics

- [Task kinds](task-kinds.md)
- [Parked runs](parked-runs.md)
- [How orc runs Pi](how-orc-runs-pi.md)
