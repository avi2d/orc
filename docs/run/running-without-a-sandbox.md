---
kind: reference
---
# Running without a sandbox
To run Pi and the checks directly on the host, add `--sandbox none` to `orc run`, as in `orc run task.md --sandbox none`.
`--sandbox nono`, the default, keeps the nono sandbox.
Without a sandbox the run still gets its own worktree on its own branch, and nono need not be on the PATH.
Pi runs with your own environment, so it can read and write anything your user can.
On a Pi login provider Pi also reads your Pi config.
On a token file or package provider Pi reads the run's own Pi folder instead, as [Configuring providers](configuring-providers.md) describes.
Orc points `GIT_CONFIG_GLOBAL` at a file in the run folder, so the commit identity Sandcastle sets never reaches your `~/.gitconfig`.
Pi writes its session straight into the run's `sessions/host` folder.
Resume takes the sandbox from the earlier run, so `orc run --branch <name>` resumes it without a sandbox.
