---
kind: reference
---
# Run the quota panel

The quota panel shows account limits.

## Run the quota tool

To run the live quota panel, run `orc-dash panel quota`.

The panel reads `quota-axi` on the machine it runs on and paints again every 30 seconds.
Two Claude accounts share the Claude brand clay, and Codex and OpenCode Go keep their own colours.
Each account gets its own block, titled with its account key.
A provider `quota-axi` reports as not set up gets no block, so the panel shows only the Claude, Codex and OpenCode Go accounts you use.
When no provider is set up, the panel shows `no provider is set up in quota-axi`.
An exhaustion projection made early in a window reads muted and marked `early` instead of as a warning.
Press `q` or Control C to quit.


The panel reads available Codex and Claude Code quota from local logs and asks `quota-axi` for missing readings.
A reading at least an hour old shows its age instead of a percentage and countdown.
OpenCode Go always uses `quota-axi`.
When `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects a Claude account, the panel cannot tie log readings to it and does not use them.
A fresh Codex rollout suppresses `quota-axi` reads for Codex, so another Codex login appears only after that rollout is an hour old.
See [Capture usage as it happens](session-quota/capture.md) for Claude statusline readings.

To print one frame, run `orc-dash panel quota --print`.

### Show saved profiles

The panel shows a block for each saved Claude profile other than the active one when `ORC_DASH_SAVED_PROFILES` names a shell command that prints them.
With `ORC_DASH_SAVED_PROFILES` unset or blank, the panel runs nothing for them and shows no saved block.

The command prints one JSON object with `schema` 2, the `active_profile` name or `null`, and `profiles`.
Each profile carries `name`, `active`, `provider`, `harness`, `tier` or `null`, `stale`, `fetched_at` or `null`, and `windows`.
Each window carries `label`, `utilization_pct` and `resets_at` or `null`.
Both panels title the Claude account with the active profile's name, such as `claude main` for a profile named `main`.

| Variable | What it sets |
| --- | --- |
| `ORC_DASH_SAVED_PROFILES` | The shell command that prints the saved profiles |

### Show each Claude account

The panel shows a block for each Claude account named by the config file's `accounts` key, titled `claude` and the account's name.
The config file is `ORC_DASH_CONFIG`, or `orc-dash/config.json` under `XDG_CONFIG_HOME`, which defaults to `~/.config`.
`accounts` maps each name to the absolute path of that account's own Claude config folder:

```json
{ "accounts": { "main": "/home/me/claude-profiles/main", "second": "/home/me/claude-profiles/second" } }
```

A name starts with a letter or digit and holds only letters, digits, `.`, `_` and `-`.
The command refuses two accounts on one folder, and a folder that is not a plain absolute path.
It also refuses `~/.claude`, since every session with no folder of its own shares that login.
An account's block shows the windows the statusline or the bridge read under that folder.
It says `no statusline reading in the last hour` when the last hour holds no reading.
The block never shows a reading taken under another folder, and the panel does not ask `quota-axi` about it.

To feed an account's block, give the `settings.json` in that account's folder a statusline that runs the capture writer:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /path/to/orc/packages/session-quota/dist/capture-bin.js claude-statusline",
    "refreshInterval": 30
  }
}
```

Run `bun run build` in the clone first, as [Build the writer](session-quota/capture.md#build-the-writer) says, and put the clone's path in place of `/path/to/orc`.
Claude Code started with `CLAUDE_CONFIG_DIR` set to the folder reads that `settings.json` and runs the statusline with the same variable, so each reading names the folder.
The writer prints nothing, so to keep another statusline's text, read stdin once and pipe it to both commands.
