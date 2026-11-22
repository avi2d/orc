---
kind: reference
---
# Account folders and orc login

For an account with a sign-in, `orc login <account>` makes one account's folder under the orc home and runs that vendor's own sign-in with its config pointed at the folder.

## Accounts

The account set is closed, and `orc login` refuses any other name.

| Account | Sign-in |
| --- | --- |
| `claude-main` | `claude auth login` with `CLAUDE_CONFIG_DIR` set to the account folder |
| `claude-second` | Not available yet |
| `openai` | Not available yet |
| `opencode` | `opencode auth login` with `XDG_DATA_HOME` set to the account folder |

## Folder layout

Each account has one folder, `~/.orc/accounts/<account>`, or `$ORC_HOME/accounts/<account>` when `ORC_HOME` is set.
`orc login` makes the folder with mode `0700` when it is missing.
`orc login` makes no folder for an account with no sign-in yet.
Two accounts never share a folder, and `orc login` refuses an account folder that is a link.
The sign-in reads no other account folder from its folder variable.
Orc sets `CLAUDE_CONFIG_DIR` or `XDG_DATA_HOME` to the account's own folder over any value the shell exports.
OpenCode keeps its data in the `opencode` folder inside `XDG_DATA_HOME`, so its key file is `accounts/opencode/opencode/auth.json`.

## No browser

Orc treats a machine as having no browser when `SSH_CONNECTION` or `SSH_TTY` is set, or on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
On such a machine orc prints a note before the Claude sign-in starts.
Claude Code has no separate flag for this case: `claude auth login` prints a link when no browser opens.
Open the link on any device, sign in, and paste the code the page shows back into the terminal.
The OpenCode sign-in asks for a provider's API key and opens no browser, so orc prints no note for `opencode`.

## No copy

The vendor's sign-in runs with the terminal's input and output, with its config held in the account folder.
On Linux the Claude credential stays in that folder.
On macOS the Claude credential stays in the login keychain under a name tied to that folder.
For `opencode` you paste the key into OpenCode's own prompt, which reads the terminal's input, and the key stays in that folder.
Orc never reads, prints or copies a credential, and it opens no file inside the account folder.
`tests/e2e/login.test.ts` holds these rules for `claude-main` and `opencode`.
The sign-in reads no other account folder from its folder variable.
The Claude sign-in prints no token-shaped value and opens no credential file.
The OpenCode sign-in keeps the pasted key out of orc's output and out of every file outside the `opencode` folder.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
