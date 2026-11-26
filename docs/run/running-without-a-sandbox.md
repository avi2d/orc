---
kind: reference
---
# Running without a sandbox
Queued tasks always pass `--sandbox none`, so [Pi](https://pi.dev) and the checks run directly on the host without a per-agent sandbox.
A hand-typed `orc run task.md` uses the [nono](https://nono.sh) sandbox by default unless you pass `--sandbox none`.

The safety boundary is the isolated space that runs the whole agent system.
Use a separate Linux system without admin rights or host drives, with narrow, revocable logins and a memory and CPU cap per task.
Orc does not create or enforce that space.

Without a sandbox the run still gets its own worktree on its own branch, and nono need not be on the PATH.
Pi runs as your user, so it can read and write anything your user can.
On a Pi login provider Pi also reads your Pi config.
On a token file or package provider Pi reads the run's own Pi folder instead, as [Configuring providers](configuring-providers.md) describes.
Orc points `GIT_CONFIG_GLOBAL` at a file in the run folder that holds only your `user.name` and `user.email`.
So Pi's [git](https://git-scm.com) reads none of your other settings and writes nothing to your `~/.gitconfig`.
Pi gets the variables a short list names instead of your whole environment, and no `ORC_` variable.
Pi writes its session straight into the run's `sessions` folder.
Resume takes the sandbox from the earlier run, so `orc run --branch <name>` retains that run's sandbox choice.
With no recorded sandbox choice, a run uses `nono` unless you pass `--sandbox none`.
