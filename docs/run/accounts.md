---
kind: reference
---
# Account folders and orc login

`orc login <account>` makes one account's folder under the orc home and runs that vendor's own sign-in with its config pointed at the folder.

## Accounts

The account set is closed, and `orc login` refuses any other name.

| Account | Sign-in |
| --- | --- |
| `claude-main` | `claude auth login` with `CLAUDE_CONFIG_DIR` set to the account folder |
| `claude-second` | Not available yet |
| `openai` | Not available yet |
| `opencode` | Not available yet |

## Folder layout

Each account has one folder, `~/.orc/accounts/<account>`, or `$ORC_HOME/accounts/<account>` when `ORC_HOME` is set.
`orc login` makes the folder with mode `0700` when it is missing.
Two accounts never share a folder, and `orc login` refuses an account folder that is a link.
The sign-in gets only its own folder: orc sets `CLAUDE_CONFIG_DIR` to it over any value the shell exports.

## No browser

Orc treats a machine as having no browser when `SSH_CONNECTION` or `SSH_TTY` is set, or on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
On such a machine orc prints a note before the sign-in starts.
Claude Code has no separate flag for this case: `claude auth login` prints a link when no browser opens.
Open the link on any device, sign in, and paste the code the page shows back into the terminal.

## No copy

The vendor's sign-in runs with the terminal's input and output, with its config held in the account folder.
On Linux the credential stays in that folder.
On macOS the credential stays in the login keychain under a name tied to that folder.
Orc never reads, prints or copies a credential, and it opens no file inside the account folder.
`tests/e2e/login.test.ts` holds both rules: the sign-in sees only its own folder, and the command prints no token-shaped value and opens no credential file.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
