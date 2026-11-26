---
kind: reference
---
# Backlog configuration

`dispatch.json` and `projects.json` tell the beat where and how to run tasks.
Both files live in `$ORC_HOME/backlog`, or `~/.orc/backlog` when `ORC_HOME` is unset.

## Dispatch configuration

`dispatch.json` defines machines, their slot limits and commands, and the quota and accounts.
Its optional [`routing` section](dispatch-rules.md) picks models and quota accounts per task.
Each slot limit also sets the [pueue](https://github.com/Nukesor/pueue) `orc` group's parallel limit when `orc runner start` queues a task.

Each account has one credential kind:

- `token-file` names a `tokenFile`.
  Each machine needs a start command.
- `token-command` names a `tokenCommand` for a renewable token on the dispatching machine.
  Each machine needs both start and `renew` commands.
- `none` supplies no token for a provider or [Pi](https://pi.dev) package that handles login itself.
- `claude-config` names a [Claude](https://claude.com) config directory on each machine.

An account with only `tokenFile` or `tokenCommand` is read as the matching kind.
The optional `floorPercent` sets the minimum remaining quota.
Without a floor, an account at 0% still cannot run.
For example:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] },
    { "name": "linux-box", "slots": 4, "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"] }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [
      { "name": "main", "tokenFile": "/Users/me/.secrets/main-token" },
      { "name": "second", "tokenFile": "/Users/me/.secrets/second-token" }
    ]
  }
}
```

Set a machine's `loadLimit` above zero to pause starts while its five-minute load is above the limit or unread.
The start command must run `orc runner start`.

On a machine whose start command runs `orc runner start`, the beat also pauses starts when its heavy queue has at least three calls.
An unread heavy queue does not hold starts.

Each provider must be defined in `config.json` on each machine that runs tasks.
Token file paths in `dispatch.json` must exist on those machines.
Token-command accounts store tokens in each machine's runner token folder instead.
Orc runs the quota command with no input and reads its standard output as this document:

```json
{
  "schema": "orc.quota.v1",
  "accounts": [
    { "name": "main", "remainingPercent": 40 },
    { "name": "second", "unusable": "the login expired" }
  ]
}
```

Each entry gives remaining quota from 0 to 100, or why the account cannot run.
An account missing from the document cannot run.

### Accounts on other providers

An account may name its own `provider`, and the `models` its runs take from that provider:

```json
{
  "name": "openai",
  "provider": "codex",
  "models": { "implementer": "codex/gpt-5.5", "fixer": "codex/gpt-5.5" },
  "tokenFile": "/Users/me/.secrets/openai-token"
}
```

Without [dispatch rules](dispatch-rules.md), the beat picks the account with the most remaining quota across every provider.
Without routing, the run takes that account's provider and models through `ORC_TASK_IMPLEMENTER_MODEL` and `ORC_TASK_FIXER_MODEL`.
With routing, the run takes the selected account's provider and receives the routed models as JSON through `ORC_TASK_ROUTED_MODELS`.
The beat leaves the other two model variables empty.
An account without a `provider` takes the quota's `provider`.
When neither routing nor account `models` is set, the run takes its models from `config.json` or the agent files.
An account whose provider differs from the quota's must name `models`, and each model must come from the account's provider.
A model an agent file names still takes precedence, so the agent files of a project that runs on several providers name no model.

### Quota from quota-axi

The quota command may instead print the document [quota-axi](https://github.com/kunchenguid/quota-axi) prints for `quota-axi --full --json --provider <id>`, such as `["quota-axi", "--full", "--json", "--provider", "codex"]`.
Orc matches each account to `accountKey` or `accountKeys` and reads the `effectivePercentRemaining` of the entry's `all_models` scope under `quotaSemantics`, so a [Codex](https://github.com/openai/codex) code review window does not count.
The account's reset time is the `resetsAt` of the scope's limiting window, the latest one when several tie, and the beat line prints it after the room.
An account without a window or percentage cannot run.
A document with no windows or duplicate account keys leaves the quota unread.

### Quota from subquo

The quota command may instead print the `subquo.v1` snapshot `subquo read --json` prints, such as `["subquo", "read", "--json"]`.
A quota command whose program is `subquo` runs the subquo copy installed with Orc's npm package, and runs `subquo` from PATH when that copy is missing.
Orc reads the account room as the smallest `percentLeft` among its windows with scope `all`, so a window that covers one model only does not limit the account.
The reset time is the `resetsAt` of the limiting window, the latest one when several tie.
An account with a stale or unavailable reading, a fresh reading past its `validUntil`, or an unknown percent or reset cannot run.
A snapshot that names no quota account, names one account twice, or breaks the `subquo.v1` shape leaves the whole quota unread.

A command that is not installed, exits non-zero, runs past 15 seconds or prints any other document leaves the quota unread, and the beat starts nothing.

### Reading quota without running the beat

Run `orc quota` on the machine that runs the beat to see its quota line without starting tasks.
For example, set `quota.command` to `["subquo", "read", "--json"]` and run `orc quota --json` to read your configured accounts.

A JSON reading with `kind: "read"` gives `floorPercent`, `accounts` in configuration order, and `pick`, which is the chosen account name or `null`.
With [dispatch rules](dispatch-rules.md#candidates-and-quota), `pick` is always `null`, because the account is chosen per task.
Each usable account gives `remainingPercent` and, if the source supplies it, `resetsAt`.
Each unusable account gives its `reason`.
A reading with `kind: "unread"` gives `reason` and a machine-readable `cause`: `command-missing`, `exit`, `timeout`, `no-json`, `spawn`, `schema`, or `account-missing`.
Both kinds of reading exit successfully.
If Orc cannot read `dispatch.json`, the command reports the configuration error on standard error and exits non-zero.

### Token command accounts

A quota with a token command account then looks like this:

```json
{
  "machines": [
    {
      "name": "linux-box",
      "slots": 4,
      "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"],
      "renew": ["orc", "runner", "renew", "--", "ssh", "linux-box", "orc"]
    }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [{ "name": "main", "tokenCommand": ["orc", "runner", "token", "/Users/me/claude-credentials/main.json"] }]
  }
}
```

Orc runs the token command with no input and reads its standard output as this document:

```json
{ "schema": "orc.token.v1", "token": "<the token>", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

The token must be printable ASCII without spaces and must not expire within five minutes.
A failed or malformed command, or one taking more than 15 seconds, leaves the account waiting.
A later beat can start the task when the command returns a live token.

`orc runner token <claude-credentials.json>` reads a [Claude Code](https://claude.com/product/claude-code) access token and expiry into a pipe.
It refuses a file containing a refresh token.
You must keep the file fresh.

### Accounts without tokens

An account of kind `none` holds no token: the beat mints nothing, sends nothing, renews nothing and never waits on a token for it.
A Pi package that logs in on its own takes this kind, as in a `claude-bridge` package that drives the Claude Code SDK while the dispatched run still goes through the `main` account named here:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] }
  ],
  "quota": {
    "provider": "claude-bridge",
    "command": ["my-quota-reader", "--json"],
    "accounts": [{ "name": "main", "kind": "none" }]
  }
}
```

Its `config.json` provider names the package with `credential` `package`, and its `env` points at the login the runs take, such as a `CLAUDE_CONFIG_DIR`.
With no `CLAUDE_CONFIG_DIR` the runs take your ordinary Claude login under `~/.claude`.
A kind `none` account spends the one login its provider holds, so a quota with another account on that provider is refused.
A kind `none` account beside a machine `renew` command is refused too, unless a token command account takes the renewal.

### Subscription logins on other providers

A Pi login names no token, so an account for a subscription Pi signs in to, such as a ChatGPT plan on Pi's `openai` provider or an [OpenCode](https://opencode.ai) Go plan, takes kind `none` and its own `provider`.
Sign Pi in to each provider on every machine that runs tasks, and define each one in `config.json` with `credential` `pi-login`.
Each account sits beside the Claude account the runs already take, and the beat picks among all of them:

```json
{
  "quota": {
    "provider": "claude-bridge",
    "command": ["subquo", "read", "--json"],
    "accounts": [
      { "name": "main", "kind": "claude-config", "configDirs": { "mac": "/Users/me/claude/main" } },
      { "name": "codex", "kind": "none", "provider": "openai", "models": { "implementer": "openai/gpt-5.5", "fixer": "openai/gpt-5.5" } },
      { "name": "opencode-go", "kind": "none", "provider": "opencode-go", "models": { "implementer": "opencode-go/kimi-k3", "fixer": "opencode-go/kimi-k3" } }
    ]
  }
}
```

With subquo as the quota command, each account name is the id subquo gives that subscription.

### Claude config accounts

To select between Claude logins, give each account a `configDirs` entry for every machine:

```json
{
  "accounts": [
    { "name": "main", "kind": "claude-config", "configDirs": { "mac": "/Users/me/claude/main", "linux-box": "/home/me/claude/main" } },
    { "name": "second", "kind": "claude-config", "configDirs": { "mac": "/Users/me/claude/second", "linux-box": "/home/me/claude/second" } }
  ]
}
```

The provider must use `credential: "package"`.
The runner sets `CLAUDE_CONFIG_DIR` to the picked account's directory for the machine, overriding the provider's configured value.
Orc sends paths, not credentials, to the runner.

### One login without a quota reader

With one login and no tool that reads its room, name one account of kind `none` and a quota command that always reports room:

```json
{
  "machines": [{ "name": "laptop", "slots": 1, "start": ["orc", "runner", "start"] }],
  "quota": {
    "provider": "opencode-go",
    "command": ["sh", "-c", "echo '{\"schema\":\"orc.quota.v1\",\"accounts\":[{\"name\":\"main\",\"remainingPercent\":100}]}'"],
    "accounts": [{ "name": "main", "kind": "none" }],
    "floorPercent": 0
  }
}
```

The runs then take the login the provider already holds, such as Pi's own login for a `pi-login` provider.

## Project configuration

`projects.json` names each project and its checkout on each machine:

```json
{ "projects": [{ "name": "orc", "checkouts": { "mac": "/Users/me/code/orc", "linux-box": "/home/me/code/orc" } }] }
```

A project may add `"mode"`, as [Delivery modes](delivery-modes.md) shows, and `"yolo"`, as [Merging a task's PR](merging-a-tasks-pr.md) shows.

Set `instructions` to a Markdown file for the project's runs and chat.
Use an absolute path or a path relative to `projects.json`.
The file must exist and replaces a discovered APPEND_SYSTEM.md.

Set `floor` to a priority from 0 to 4 to start only the project's tasks at that priority or a more urgent one.
With `"floor": 1`, the beat starts P0 and P1 tasks and waits on P2, P3 and P4 tasks with the reason `P2 is under the floor P1 of the project orc`.
A project without `floor` starts tasks of every priority.
Orc refuses a floor that is not a whole number from 0 to 4.

### Upstream contributions

Add `upstream` to a project to watch [GitHub](https://github.com) issue and PR URLs.
The beat reads them with the dispatch machine's `gh` login.
When a contribution changes after its first read, the beat adds a scout task with no priority.
Assign a priority to start it.

Orc accepts GitHub issue and pull request URLs and refuses duplicate entries.
If `gh` cannot read a contribution, the beat reports the reason and keeps its last state.
If the recorded state is unreadable, remove the named file so the next beat can record it again.
