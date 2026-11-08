---
kind: reference
---
# Configuring providers
Orc ships with no provider and no model, so a run needs `config.json` in `$ORC_HOME`, default `~/.orc/config.json`.
It names each provider orc may run and, under `models`, the implementer, fixer and orchestrator models.
This example names opencode-go through a Pi login, anthropic through a token file and claude-bridge through its Pi package:

```json
{
  "providers": [
    { "id": "opencode-go", "credential": "pi-login", "nono": { "upstream": "https://opencode.ai/zen/go/v1" } },
    { "id": "anthropic", "credential": "token-file", "tokenFile": { "env": "ANTHROPIC_TOKEN_FILE" } },
    {
      "id": "claude-bridge",
      "credential": "package",
      "packages": ["git:github.com/avi2d/pi-claude-bridge@v0.9.3+avi2d.8"],
      "env": { "CLAUDE_CONFIG_DIR": "/Users/me/claude-profiles/main" }
    }
  ],
  "models": {
    "implementer": "claude-bridge/claude-opus-5-5",
    "fixer": "claude-bridge/claude-opus-5-5",
    "orchestrator": "claude-bridge/claude-sonnet-5-5"
  }
}
```

Each provider names its Pi provider `id`, the part of a model name before the `/`, and its `credential`:

- `pi-login` checks the Pi login for that provider before the run, as [Running a task](running-a-task.md) describes.
  Its `nono` entry names the `upstream` URL the nono sandbox proxies with that login's key.
  Its `nono` entry may name `injectHeader` and `credentialFormat`.
  `injectHeader` names the HTTP header the proxy fills with the key and defaults to `Authorization`.
  `credentialFormat` names the header value with `{}` where the key goes and defaults to `Bearer {}`.
  A login provider without a `nono` entry runs only with `--sandbox none`.
- `token-file` reads the token from a file, whose absolute path `tokenFile` takes from the variable `env` names or from `path`.
  `orc run --token-file <path>` takes the path from the flag instead.
  The nono sandbox carries only a Pi login, so a token file provider runs only with `--sandbox none`.
- `package` hands the run no key, since the provider's own Pi package reaches its service.
  `packages` lists the Pi package sources, in the form Pi's `settings.json` takes: `npm:`, `git:`, a git URL or an absolute path.
  Orc writes them into the run's Pi folder, `session/agent/settings.json`, so the run's Pi loads the package your Pi loads.
  Pi installs an `npm:` or `git:` source into the run's folder on the first model list, so each run fetches it again.
  An absolute path to a package already on the machine, such as one under `~/.pi/agent/git`, loads without the fetch.
  `env` names variables orc sets for the run's Pi over your environment, and for the chat's Pi when `models.orchestrator` names this provider, such as the `CLAUDE_CONFIG_DIR` of the account a Claude Code package runs on.
  The nono sandbox carries only a Pi login, so a package provider runs only with `--sandbox none`.

Orc refuses a `config.json` key it does not know, so a misspelled key never drops a provider unnoticed.
Orc refuses `--token-file` on a provider that takes a Pi login or Pi packages.
`orc run --provider <id>` refuses a run whose implementer model is on another provider, so a token meant for one provider never reaches another.
Orc refuses a token file that is unset, relative, missing, empty, not a regular file or readable by other users.
On a token file provider, Pi reads the run's own Pi folder instead of yours.
So a login stored in your Pi config never stands in for the token.
The run's `models.json` names the token file only through `AGENT_TOKEN_FILE`.
Pi reads the file when it calls the provider and holds the token only in memory, so no run file keeps it.
Orc never copies, moves or deletes the token file.
A provider defined only in the operator's Pi models.json is not carried into a run directory, so use a provider Pi knows built in or one a configured package adds.
