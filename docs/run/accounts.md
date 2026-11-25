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
| `openai` | `codex login` with `CODEX_HOME` set to the account folder |
| `opencode` | `opencode auth login` with `XDG_DATA_HOME` set to the account folder |

## Folder layout

Each account has one folder, `~/.orc/accounts/<account>`, or `$ORC_HOME/accounts/<account>` when `ORC_HOME` is set.
`orc login` makes the folder with mode `0700` when it is missing.
`orc login` makes no folder for an account with no sign-in yet.
Two accounts never share a folder, and `orc login` refuses an account folder that is a link.
The sign-in reads no other account folder from `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME`.
Orc sets the vendor's variable to the account's own folder over any value the shell exports.
OpenCode keeps its data in the `opencode` folder inside `XDG_DATA_HOME`, so its key file is `accounts/opencode/opencode/auth.json`.

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
On such a machine orc prints a note before the Claude or Codex sign-in starts.
For `claude-second`, orc sets `BROWSER` to an opener script that opens nothing, so neither an opener the shell exports nor the system opener opens the link in a normal window.
[Claude Code](https://claude.com/product/claude-code) has no separate flag for this case: `claude auth login` prints a link when no browser opens.
Open the link on any device, sign in, and paste the code the page shows back into the terminal.
For `openai` orc runs `codex login --device-auth` instead, which is [Codex](https://github.com/openai/codex)'s device-code sign-in.
Codex prints a link and a code.
Open the link on any device, sign in, and enter the code there.
The OpenCode sign-in asks for a provider's API key and opens no browser, so orc prints no note for `opencode`.

## No copy

The vendor's sign-in runs with the terminal's input and output, with its config held in the account folder.
For [Claude](https://claude.com) on Linux the credential stays in that folder.
For Claude on macOS the credential stays in the login keychain under a name tied to that folder.
Codex keeps the credential in `auth.json` in that folder by default.
For `opencode` you paste the key into OpenCode's own prompt, which reads the terminal's input, and the key stays in that folder.
Orc never reads, prints or copies a credential, and it opens no file inside the account folder.
`tests/e2e/login.test.ts` holds these rules for `claude-main`, `claude-second`, `openai` and `opencode`.
It signs the Claude accounts in side by side, and each sign-in sees only its own folder in `CLAUDE_CONFIG_DIR` and writes only there.
The sign-in reads no other account folder from `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME`.
The Claude sign-in prints no token-shaped value and opens no credential file.
The Codex sign-in prints no token-shaped value and opens no credential file.
The OpenCode sign-in keeps the pasted key out of orc's output and out of every file outside the `opencode` folder.

## Related topics

- [Backlog configuration](backlog-configuration.md)
- [Configuring providers](configuring-providers.md)
