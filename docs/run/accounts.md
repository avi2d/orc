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
| `claude-second` | `claude auth login` with `CLAUDE_CONFIG_DIR` set to the account folder, in a private browser window |
| `openai` | Not available yet |
| `opencode` | Not available yet |

## Folder layout

Each account has one folder, `~/.orc/accounts/<account>`, or `$ORC_HOME/accounts/<account>` when `ORC_HOME` is set.
`orc login` makes the folder with mode `0700` when it is missing.
`orc login` makes no folder for an account with no sign-in yet.
Two accounts never share a folder, and `orc login` refuses an account folder that is a link.
The sign-in reads no other account folder from `CLAUDE_CONFIG_DIR`: orc sets `CLAUDE_CONFIG_DIR` to its own folder over any value the shell exports.

## Private window

A browser keeps the claude.ai session of the account that signed in there, so a second Claude sign-in in a normal window authorizes that account again.
For `claude-second`, orc opens the sign-in link in a private or incognito window of the default browser instead.
Orc reads the default browser from `xdg-settings get default-web-browser` on Linux and from the `https` handler in the LaunchServices settings on macOS.
Orc writes a small opener script to a temporary folder and sets `BROWSER` to it, and Claude runs `$BROWSER` with the sign-in link.
The script runs the browser with its private-window flag, and orc removes the folder when the sign-in ends.

| Browser | Private-window flag |
| --- | --- |
| Firefox, and LibreWolf on Linux only | `--private-window` |
| Chrome, Chromium, Brave and Vivaldi | `--incognito` |
| Edge | `--inprivate` |

On macOS orc opens the browser with `open -na <app> --args <flag>`.
Orc never opens the link in a normal window for `claude-second`.
For any other default browser, such as Safari, the opener script opens nothing, and orc prints a note.
Claude then prints the link, and you open it in a private window yourself.
`claude-main` signs in through the normal window of the default browser.

## No browser

Orc treats a machine as having no browser when `SSH_CONNECTION` or `SSH_TTY` is set, or on Linux when neither `DISPLAY` nor `WAYLAND_DISPLAY` is set.
On such a machine orc prints a note before the sign-in starts.
For `claude-second`, orc sets `BROWSER` to an opener script that opens nothing, so neither an opener the shell exports nor the system opener opens the link in a normal window.
Claude Code has no separate flag for this case: `claude auth login` prints a link when no browser opens.
Open the link on any device, sign in, and paste the code the page shows back into the terminal.

## No copy

The vendor's sign-in runs with the terminal's input and output, with its config held in the account folder.
On Linux the credential stays in that folder.
On macOS the credential stays in the login keychain under a name tied to that folder.
Orc never reads, prints or copies a credential, and it opens no file inside the account folder.
`tests/e2e/login.test.ts` holds both rules for `claude-main` and `claude-second`.
It signs both accounts in side by side, and each sign-in sees only its own folder in `CLAUDE_CONFIG_DIR` and writes only there.
For each account the command prints no token-shaped value and opens no credential file.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
