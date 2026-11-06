---
kind: reference
---
# Run the session panel
To run the live panel, run `tui-dash panel session-quota`.
The panel paints again every 30 seconds and says `reading local session logs…` until the first read of the logs finishes.
It fits the terminal's rows by showing fewer sessions a window, and it keeps every flagged session in view.
Below one row a window, it shows the flags first and then whatever notes still fit.
When two lines a flag do not fit, each flag takes one line with its session, window cycle and account.
When even one line a flag does not fit, the panel shows the flags that fit.
Its last line counts the rest and names the repository root's `session-quota-json` script, which lists every flag, or `session-quota-composed-json` when a second machine is composed.
A terminal too narrow for that line on one row wraps it onto two.
Heights under eight rows are not a supported layout, so there that line can be cut, and the script still lists every flag.
The dashboard shows only the flags, each naming the agent's project, the account and the limit.
It reads the Pi logs under `HOME`, the Codex logs under `CODEX_HOME` or `~/.codex`, and the Claude Code logs under `CLAUDE_CONFIG_DIR` or `~/.claude`.
Those are the homes of the logins `quota-axi` reads.
Each account opens with the assumption that joined its calls to it, such as joined by credential key or assumed the only login.
A window is read from a harness log when the log covered its provider within the hour, or read it later than quota-axi did.
Such a window names that log and the reading's age, such as from codex rollout 38m ago.
It names the reading's join too when that differs from the account's.
An account read from a harness log stands for the credential that log ran under.
A call keyed to another credential of that provider joins no account.
When quota-axi fails, each provider it was asked about shows the failure under its own heading.
The accounts read from harness logs keep their windows and flags.
Each window lists its sessions ranked by price weighted share, with the raw share, the upper bound in points and the points per hour.
Points per hour above 999 read >999, and the JSON report holds the exact rate.
A live session reads ● and an ended one ○, and a flagged session reads ⚑.
A window with a flagged session reads over fair share flagged.
It reads lasts to reset instead when the window is not running out before its reset.
It reads none over fair share when the window runs out but no session carries a flag.
A session that has ended is never flagged.
It never pauses, stops or reroutes a session.
A window with no local calls reads none logged here, and its used points count as unattributed.
A window quota-axi still reports after its reset reads unknown pace, shows no fair share, counts only the calls before its reset, and flags nobody.
A window read an hour old or more reads its age instead of its used points, fair share and pace.
Such a window reads 7d window read 13h 0m ago, for example.
Its sessions keep their shares, drop the points and points per hour, and none is flagged.
The trailing hour is the hour before the read, its first instant included.
A window past its reset holds no trailing-hour spend once that reset is an hour past.
A headless process takes its folder's newest log only when it is the only process of its harness there.
It also needs no Herdr pane of that harness to name a log there or run there.
Otherwise the panel names the processes that share the folder, and the folder's logs read as ended.
Press `q` or Control C to quit.

To print one frame of plain text instead, run `tui-dash panel session-quota --print`, and add `--width 40` for a narrow frame.
