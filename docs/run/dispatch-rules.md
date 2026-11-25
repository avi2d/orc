---
kind: reference
---
# Dispatch rules

The beat reads `routing` in `$ORC_HOME/backlog/dispatch.json` to pick an account and models for each task.
Without `routing`, the beat uses the account with the most remaining quota and keeps the usual account and agent model settings.
A direct `orc run` does not read dispatch rules.

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
| `tasks.<id>.model` | A model pin that replaces both the rules and the default for this task. |
| `tasks.<id>.estimatedLines` | A whole number of changed lines you expect. Orc does not estimate it. |

The first matching rule supplies the candidate list.
If none of its candidates has an eligible account, the task waits rather than moving to another rule or the default.
A pinned task waits if the pinned model's provider has no eligible account.

## Candidates and quota

Each candidate list contains at least one entry, ordered from first choice to last.
A string candidate names a `provider/model` for all Orc agent roles.
An object candidate requires `models.implementer` and can name `models.fixer` and `models.reviewer`.
If omitted, the fixer uses the implementer model, and the reviewer uses the fixer model.
The reviewer model applies only to Orc's `direct-PR` delivery.
The no-mistakes reviewer has its own settings.

All models in a candidate must use the same provider.
Orc takes the account on that provider with the most quota above zero and at or above `quota.floorPercent`.
An object candidate with `account` considers only that account.
If no account qualifies, Orc tries the next candidate.
Each provider in use must appear in `config.json` and have a quota account in `dispatch.json`.
The quota reading does not check whether an account can run a particular model.
For a model that only some accounts can run, name one of those accounts in the candidate.

## Model overrides

For a run started by dispatch rules, a model flag applies to the implementer and fixer together.
`--implementer-model` wins over `--fixer-model`.
`orc runner start` passes `ORC_TASK_IMPLEMENTER_MODEL` as `--implementer-model`.
If neither flag is set, a model in the implementer agent file wins over a model in the fixer agent file.
A reviewer agent file can still name its own model.
All the final models must use the provider of the chosen quota account.
To pin a different provider, use `tasks.<id>.model` so the beat can choose the matching account.

## Example routing

This `routing` section puts design, CI, release, and diagnosis rules before the broader implementation rule.
Design work tries Fable on `fable-access` first and falls back to Opus when that account is missing, unusable, or below the floor.
The task ID, category, account, and model names reflect the projects, quota accounts, and providers you configure.

```json
{
  "routing": {
    "rules": [
      {
        "when": { "category": "design" },
        "candidates": [
          { "account": "fable-access", "models": { "implementer": "claude-bridge/claude-fable-5" } },
          "claude-bridge/claude-opus-5-5"
        ]
      },
      { "when": { "category": "ci" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      { "when": { "category": "release" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      { "when": { "category": "diagnosis" }, "candidates": ["claude-bridge/claude-opus-5-5"] },
      {
        "when": { "kind": "ship", "project": "editor", "category": "specified", "minEstimatedLines": 151 },
        "candidates": ["codex/gpt-6.2-sol", "claude-bridge/claude-opus-5-5"]
      },
      { "when": { "kind": "scout" }, "candidates": ["codex/gpt-6.1-terra", "claude-bridge/claude-opus-5-5"] }
    ],
    "default": ["claude-bridge/claude-opus-5-5"],
    "tasks": {
      "editor-10": { "category": "design" },
      "editor-11": { "category": "specified", "estimatedLines": 175 },
      "editor-12": { "model": "codex/gpt-6.2-sol" }
    }
  }
}
```

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
- [Task kinds](task-kinds.md)
