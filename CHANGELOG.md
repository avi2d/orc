# Changelog

Every release of `orc`, newest first, written by the release from its conventional commits.

## 0.4.0

Released 2026-10-30.

### Features

- **run:** warn and hand over on long Pi sessions [#40](https://github.com/avi2d/orc/pull/40)
- **dispatch:** add queue panel for machines, runs and waiting tasks [#39](https://github.com/avi2d/orc/pull/39)
- **dispatch:** hand runs a rolling token from the dispatching machine [#38](https://github.com/avi2d/orc/pull/38)
- move tui-dash dashboard packages into the orc workspace [#32](https://github.com/avi2d/orc/pull/32)
- **run:** configure providers, models, and quota via config [#37](https://github.com/avi2d/orc/pull/37)
- **run:** record the sandbox kind in run history and resume from it [#35](https://github.com/avi2d/orc/pull/35)
- **run:** run Pi on a Claude model with a caller-named token file [#31](https://github.com/avi2d/orc/pull/31)
- **run:** name the reviewer that served each run [#29](https://github.com/avi2d/orc/pull/29)
- **run:** add --sandbox none for host runs without nono [#24](https://github.com/avi2d/orc/pull/24)
- feed the private list into the secrets gate on every change [#25](https://github.com/avi2d/orc/pull/25)
- **dispatch:** run tasks through pueue so runs outlive the dispatcher [#28](https://github.com/avi2d/orc/pull/28)
- **dispatch:** add backlog and beat that starts each task once [#27](https://github.com/avi2d/orc/pull/27)
- **run:** write 150k token compaction mark into each run's Pi folder [#26](https://github.com/avi2d/orc/pull/26)
- **run:** move orc command into scoped workspace package [#21](https://github.com/avi2d/orc/pull/21)
- install and run orc without firstmate tooling [#17](https://github.com/avi2d/orc/pull/17)
- publish to npm under MIT with ORC_HOME and configurable refuse markers [#16](https://github.com/avi2d/orc/pull/16)

### Fixes

- **run:** close finished runs on beat and scope pueue labels to home [#41](https://github.com/avi2d/orc/pull/41)

## 0.3.0

Released 2026-10-23.

### Features

- **no-mistakes:** per-kind --allow word and --answer for open questions [#13](https://github.com/avi2d/orc/pull/13)
- add orc score command for rating run steps [#12](https://github.com/avi2d/orc/pull/12)

### Fixes

- drop unreadable macOS certificate grant from nono profile [#14](https://github.com/avi2d/orc/pull/14)

## 0.2.0

Released 2026-10-21.

### Features

- resume runs by branch with Pi session and no-mistakes reattach [#9](https://github.com/avi2d/orc/pull/9)
- write the run report and add orc runs and orc show [#7](https://github.com/avi2d/orc/pull/7)
- hand the branch to no-mistakes and record the PR [#6](https://github.com/avi2d/orc/pull/6)
- run project checks and up to three fix attempts [#5](https://github.com/avi2d/orc/pull/5)
- add agent files and orc run through the agent step [#4](https://github.com/avi2d/orc/pull/4)
- add the ~/.orc run history and orc runs command [#3](https://github.com/avi2d/orc/pull/3)
- add a Sandcastle sandbox provider that runs commands in nono [#2](https://github.com/avi2d/orc/pull/2)

### Fixes

- resume interrupted runs from live sessions with atomic history publish [#11](https://github.com/avi2d/orc/pull/11)
- let host git pass the gate keys no-mistakes writes [#8](https://github.com/avi2d/orc/pull/8)

## 0.1.0

Released 2026-10-18.

### Features

- scaffold orc with the checks kit and an orc --version command [#1](https://github.com/avi2d/orc/pull/1)
