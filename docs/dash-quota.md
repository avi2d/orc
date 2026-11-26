---
kind: reference
---
# Run the quota panel

The quota panel shows account limits.

## Run the quota tool

To run the live quota panel, run `orc-dash panel quota`.

The panel reads `quota-axi` on the machine it runs on and paints again every 30 seconds.
Two [Claude](https://claude.com) accounts share the Claude brand clay, and [Codex](https://github.com/openai/codex) and [OpenCode Go](https://opencode.ai) keep their own colours.
Each account gets its own block, titled with its account key.
A Claude block uses an Orc account name when exactly one account from `orc quota --json` matches a [quota-axi](https://github.com/kunchenguid/quota-axi) account key for that row.
If no key matches, the sole Claude row uses the sole Orc account name unless a configured Claude account owns that name.
Otherwise an unmatched row keeps its account key, or uses `claude` for the default key.
A provider `quota-axi` reports as not set up gets no block, so the panel shows only the Claude, Codex and OpenCode Go accounts you use.
When no provider is set up, the panel shows `no provider is set up in quota-axi`.
An exhaustion projection made early in a window reads muted and marked `early` instead of as a warning.
Press `q` or Control C to quit.


The panel reads available Codex and [Claude Code](https://claude.com/product/claude-code) quota from local logs and asks `quota-axi` for missing readings.
A reading at least an hour old shows its age instead of a percentage and countdown.
OpenCode Go uses `quota-axi` unless a subquo account is mapped.
When `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` selects a Claude account, the panel cannot tie log readings to it and does not use them.
A fresh Codex rollout suppresses `quota-axi` reads for Codex, so another Codex login appears only after that rollout is an hour old.
See [Capture usage as it happens](session-quota/capture.md) for Claude statusline readings.

### Map accounts to subquo

The panel can read a saved `subquo.v1` snapshot for accounts named in `subquoAccounts` in the dashboard config.
Each entry names the quota-axi provider, its account key, and the corresponding subquo account ID:

```json
{
  "subquoAccounts": [
    { "provider": "claude", "accountKey": "default", "subquoId": "main" }
  ]
}
```

The panel runs the installed subquo executable with `read --json`.
If the installed executable is unavailable, the panel looks for `subquo` on its PATH.
A fresh subquo reading replaces the matching five-hour and weekly windows.
For OpenCode Go, it also replaces matching rolling and monthly windows.
A missing, stale, expired, or mismatched reading leaves the quota-axi window in place.
Windows subquo does not name also keep their quota-axi readings.
The panel does not infer a mapping from account names.

To print one frame, run `orc-dash panel quota --print`.

### Show the dispatch accounts

The panel runs `orc quota --json` and shows a block for each account the dispatch quota names, titled `account` and the account's name.
It reads the same accounts, floor and pick the beat reads, as [Reading quota without running the beat](run/backlog-configuration.md#reading-quota-without-running-the-beat) describes.
The account blocks sit after the Claude blocks and before Codex.

An account the quota can read shows one `all models` row with its room left and the time to its reset.
Its header names its standing:

| Header | Meaning |
| --- | --- |
| `next run` | The beat picks this account for the next task. With [dispatch rules](run/dispatch-rules.md), no account shows it |
| `under the 20% floor` | The room is below the quota's `floorPercent`, here 20% |
| none | The beat picks another account first |

When no room is left, the account's row reads `used up`.
An account the quota cannot use reads `unusable`, with the reason `orc quota` gives below the header.
When `orc quota` reports the quota unread, one `accounts` block names the cause, such as `command not installed` or `an account is missing`, with the reason below it.
When `orc` is not on `PATH` or `dispatch.json` is missing, the `accounts` block shows the error.
In a short dashboard the account blocks fold first, into a `+2 more accounts` line.

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
    "command": "orc-dash-capture claude-statusline",
    "refreshInterval": 30
  }
}
```

Put `orc-dash-capture` on Claude Code's `PATH` as [Install orc-dash](dash.md#install) describes.
If the statusline does not inherit that `PATH`, use the absolute path to the command or its launcher.
To move an existing hook off the old [Bun](https://bun.com) bundle, see [Capture command](session-quota/capture.md#capture-command).
Claude Code started with `CLAUDE_CONFIG_DIR` set to the folder reads that `settings.json` and runs the statusline with the same variable, so each reading names the folder.
The writer prints nothing, so to keep another statusline's text, read stdin once and pipe it to both commands.
