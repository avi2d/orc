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
| `openai` | `codex login` with `CODEX_HOME` set to the account folder |
| `opencode` | Not available yet |

## Folder layout

Each account has one folder, `~/.orc/accounts/<account>`, or `$ORC_HOME/accounts/<account>` when `ORC_HOME` is set.
`orc login` makes the folder with mode `0700` when it is missing.
`orc login` makes no folder for an account with no sign-in yet.
Two accounts never share a folder, and `orc login` refuses an account folder that is a link.
The sign-in reads no other account folder from `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
Orc sets the vendor's variable to the account's own folder over any value the shell exports.

## No browser

Orc treats a machine as having no browser when `SSH_CONNECTION` or `SSH_TTY` is set, or on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
On such a machine orc prints a note before the sign-in starts.
Claude Code has no separate flag for this case: `claude auth login` prints a link when no browser opens.
Open the link on any device, sign in, and paste the code the page shows back into the terminal.
For `openai` orc runs `codex login --device-auth` instead, which is Codex's device-code sign-in.
Codex prints a link and a code.
Open the link on any device, sign in, and enter the code there.

## No copy

The vendor's sign-in runs with the terminal's input and output, with its config held in the account folder.
For Claude on Linux the credential stays in that folder.
For Claude on macOS the credential stays in the login keychain under a name tied to that folder.
Codex keeps the credential in `auth.json` in that folder by default.
Orc never reads, prints or copies a credential, and it opens no file inside the account folder.
`tests/e2e/login.test.ts` holds both rules for `claude-main` and `openai`.
The sign-in reads no other account folder from `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
The command prints no token-shaped value and opens no credential file.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
