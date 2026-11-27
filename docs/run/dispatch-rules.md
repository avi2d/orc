---
kind: reference
---
# Dispatch rules

The beat reads `routing` in `$ORC_HOME/backlog/dispatch.json` to pick an account and models for each task.
Without `routing`, the beat uses the account with the most remaining quota and keeps the usual account and agent model settings.
A direct `orc run` does not read dispatch rules.
Decision tasks never run, so dispatch rules do not apply to them.

## Rules and task settings

| Key | Meaning |
| --- | --- |
| `rules` | Rules in order. All fields in a rule's `when` must match. An empty `when` matches any task. |
| `default` | Candidates for a task that matches no rule. |
| `tasks` | Optional settings keyed by backlog task ID. |
| `when.kind` | One of `ship`, `scout`, `task`, or `parent`. |
| `when.project` | The project's name in `projects.json`. |
| `when.category` | The category set in `tasks.<id>.category`. |
| `when.minEstimatedLines` | The minimum estimated changed lines, inclusive. A task without `tasks.<id>.estimatedLines` does not match. |
| `tasks.<id>.model` | A string or object candidate that replaces both the rules and the default for this task. |
| `tasks.<id>.estimatedLines` | A whole number of changed lines you expect. Orc does not estimate it. |

The first matching rule supplies the candidate list.
If none of its candidates has an eligible account, the task waits rather than moving to another rule or the default.
A pinned task waits if its candidate has no eligible account.
An object pin can name an account and role models, with the same fields as an object candidate.

## Candidates and quota

Each candidate list contains at least one entry, ordered from first choice to last.
A string candidate names a `provider/model` for all Orc agent roles.
An object candidate requires `models.implementer` and can name `models.fixer` and `models.reviewer`.
If omitted, the fixer uses the implementer model, and the reviewer uses the fixer model.
The reviewer model applies only to Orc's `direct-PR` and `orc` deliveries.
The [no-mistakes](https://github.com/kunchenguid/no-mistakes) reviewer has its own settings.

All models in a candidate must use the same provider.
Orc takes the account on that provider with the most quota above zero and at or above `quota.floorPercent`.
An object candidate with `account` considers only that account.
The named account must exist in `quota.accounts`, and its provider must match the candidate's models.
Orc refuses the dispatch configuration if either check fails or a candidate's provider has no quota account.
These checks also apply to task pins.
If no account qualifies, Orc tries the next candidate.
Each provider in use must appear in `config.json` and have a quota account in `dispatch.json`.
Once a run starts, Orc does not retry it on another candidate if the chosen model fails.
The quota reading does not check whether an account can run a particular model.
For a model that only some accounts can run, name one of those accounts in the candidate or task pin.
With routing, quota text reports per-task account selection, and quota JSON leaves `pick` null.

## Model overrides

For a run started by dispatch rules, each role uses its own model override.
The implementer and fixer each use their agent file's model first, then their model flag, then the routed model.
`orc runner start` passes `ORC_TASK_IMPLEMENTER_MODEL` and `ORC_TASK_FIXER_MODEL` as the corresponding model flags.
A reviewer agent file's model takes precedence over the routed reviewer model.
Without routing, the same order applies, with the configured model as the default.
All the final models must use the provider of the chosen quota account.
To pin a different provider, use `tasks.<id>.model` so the beat can choose the matching account.

## Example routing

This `routing` section puts design, CI, release, and diagnosis rules before the broader implementation rule.
Design work tries Fable on `fable-access` first.
It falls back to Opus when that account's quota reading is absent, unusable, zero, or below the floor.
The task ID, category, account, and model names reflect the projects, quota accounts, and providers you configure.

```json
{
  "routing": {
    "rules": [
      {
        "when": { "category": "design" },
        "candidates": [
          { "account": "fable-access", "models": { "implementer": "claude-bridge/claude-fable-5-2" } },
          "claude-bridge/claude-opus-5-5"
        ]
      },
      { "when": { "category": "ci" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      { "when": { "category": "release" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      { "when": { "category": "diagnosis" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      {
        "when": { "kind": "ship", "project": "editor", "category": "specified", "minEstimatedLines": 151 },
        "candidates": ["openai/gpt-6.2-sol", "claude-bridge/claude-opus-5-5"]
      },
      { "when": { "kind": "scout" }, "candidates": ["openai/gpt-6.1-terra", "claude-bridge/claude-opus-5-5"] }
    ],
    "default": ["claude-bridge/claude-opus-5-5"],
    "tasks": {
      "editor-10": { "category": "design" },
      "editor-11": { "category": "specified", "estimatedLines": 175 },
      "editor-12": { "model": "openai/gpt-6.2-sol" },
      "editor-13": { "model": { "account": "fable-access", "models": { "implementer": "claude-bridge/claude-fable-5-2" } } }
    }
  }
}
```

## Images for design work

A design task's worker makes its raster images itself through the `generate-assets` skill.
The worker loads that skill from the user's skills folder, because the run's [Pi](https://pi.dev) loads skills on the host under `--sandbox none`, which every queued task passes.
The worker reaches the `winwsl` machine over [ssh](https://www.openssh.com) and uses the ChatGPT login of [Codex](https://github.com/openai/codex) there.
It runs Codex with `gpt-6-astra` and then with `gpt-6.1-sol`.
The worker keeps the design and the code itself, and orc starts no second worker for images.
When the skill reads the Codex allowance below its 20 percent weekly threshold, or gets no reading, it tells the worker to stop and ask.
The bundled implementer prompt tells the worker to ask through `orc_ask` then instead of ending the step.
The run then parks with that question, as [A worker question](parked-runs.md#a-worker-question) shows.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
- [Task kinds](task-kinds.md)
