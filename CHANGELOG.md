# Changelog

Every release of `orc`, newest first, written by the release from its conventional commits.

## 0.14.0

Released 2026-11-13.

### Features

- **run:** ask on a repeated failing command and pause a looping run [#177](https://github.com/avi2d/orc/pull/177)
- **run:** split an overflowing child into siblings under its parent [#147](https://github.com/avi2d/orc/pull/147)
- **run:** apply worker split proposal and start children [#144](https://github.com/avi2d/orc/pull/144)

### Fixes

- **run:** decide heavy stand in calls in TypeScript with fail open classifier [#146](https://github.com/avi2d/orc/pull/146)

## 0.13.0

Released 2026-11-11.

### Features

- **herdr-app:** add orc layout with board, resources and agents tabs [#140](https://github.com/avi2d/orc/pull/140)
- **dispatch:** show the beat's wait reasons in the dash [#134](https://github.com/avi2d/orc/pull/134)
- **run:** propose splits from over-budget workers [#133](https://github.com/avi2d/orc/pull/133)
- **run:** select Claude login by dispatch quota [#130](https://github.com/avi2d/orc/pull/130)
- **run:** expose backlog wait reasons in JSON [#129](https://github.com/avi2d/orc/pull/129)
- decider answers routine review questions and escalates the rest [#127](https://github.com/avi2d/orc/pull/127)
- **run:** split over budget requests into vertical slice children at intake [#126](https://github.com/avi2d/orc/pull/126)
- **dashboard:** show the attention queue by default [#125](https://github.com/avi2d/orc/pull/125)
- **run:** route run, check, merge, and wait events into attention queue [#124](https://github.com/avi2d/orc/pull/124)
- **attention:** show open queue items oldest first [#123](https://github.com/avi2d/orc/pull/123)
- **run:** add orc attention queue for review questions [#122](https://github.com/avi2d/orc/pull/122)
- **run:** parent tasks that wait for children and close on a final check [#121](https://github.com/avi2d/orc/pull/121)

### Fixes

- **run:** name the decider in a parked task's waits line [#142](https://github.com/avi2d/orc/pull/142)
- **run:** reopen withdrawn overdue waits with current hold text [#141](https://github.com/avi2d/orc/pull/141)
- **run:** reopen withdrawn review questions and label decider owned parked questions [#139](https://github.com/avi2d/orc/pull/139)
- **run:** keep heavy wrappers from calling themselves [#136](https://github.com/avi2d/orc/pull/136)
- **run:** skip decider-owned questions in chat and beat asking line [#132](https://github.com/avi2d/orc/pull/132)
- **run:** preserve host runtime directory so checks reach pueue [#128](https://github.com/avi2d/orc/pull/128)

## 0.12.0

Released 2026-11-10.

### Features

- **run:** route heavy stand-ins through an external queue command [#119](https://github.com/avi2d/orc/pull/119)

## 0.11.0

Released 2026-11-10.

### Breaking changes

- rename the dashboard from tui-dash to orc-dash [#108](https://github.com/avi2d/orc/pull/108)

### Features

- spread heavy queues across machines [#116](https://github.com/avi2d/orc/pull/116)
- **run:** queue heavy shell calls through one slot per machine [#114](https://github.com/avi2d/orc/pull/114)
- read any Claude credentials file and treat herdr as optional [#109](https://github.com/avi2d/orc/pull/109)
- **run:** record gate refusals and count them in orc refusals [#107](https://github.com/avi2d/orc/pull/107)

### Fixes

- correct heavy line docs, not-setup detection, and minutes formatting [#117](https://github.com/avi2d/orc/pull/117)
- drop stale smol-toml advisory acknowledgements [#113](https://github.com/avi2d/orc/pull/113)

## 0.10.0

Released 2026-11-08.

### Features

- **run:** stop started tasks and close runs the runner lost [#101](https://github.com/avi2d/orc/pull/101)
- **alerts:** remove nightly alert rule [#99](https://github.com/avi2d/orc/pull/99)
- **run:** drop sandcastle, run each task in its own git worktree [#98](https://github.com/avi2d/orc/pull/98)
- **run:** pause on review questions instead of failing the task [#94](https://github.com/avi2d/orc/pull/94)
- **test-fast:** cap workers by base plus increment past a reserve [#95](https://github.com/avi2d/orc/pull/95)
- **test-fast:** cap workers by available memory [#93](https://github.com/avi2d/orc/pull/93)
- **dispatch:** backlog depend, missing-backlog notice, 45-min idle limit, test home [#91](https://github.com/avi2d/orc/pull/91)

### Fixes

- **run:** separate same named task copies and correct nested worktree excludes [#100](https://github.com/avi2d/orc/pull/100)
- **run:** keep and relay every answer of a parked wait [#96](https://github.com/avi2d/orc/pull/96)
- **dispatch:** number backlog task ids per project [#90](https://github.com/avi2d/orc/pull/90)
- **run:** apply orchestrator provider env to chat Pi [#85](https://github.com/avi2d/orc/pull/85)

## 0.9.0

Released 2026-11-04.

### Features

- **run:** follow upstream contributions with scout tasks on change [#78](https://github.com/avi2d/orc/pull/78)
- **run:** per-project instructions files for runs and chat [#77](https://github.com/avi2d/orc/pull/77)
- **run:** open decision boards for held and parked tasks from chat [#76](https://github.com/avi2d/orc/pull/76)
- **run:** post alerts and task events in chat [#75](https://github.com/avi2d/orc/pull/75)
- **run:** fast-forward the default branch before each run; contribution scout split out [#74](https://github.com/avi2d/orc/pull/74)

### Fixes

- **dashboard:** check geometry at 80-240 columns, fix lone words and 7d fab… cut [#83](https://github.com/avi2d/orc/pull/83)
- **run:** watch each upstream contribution once regardless of URL spelling [#79](https://github.com/avi2d/orc/pull/79)
- **deps:** override minimatch to 11.0.3 and qs to 6.16.1 [#73](https://github.com/avi2d/orc/pull/73)

## 0.8.0

Released 2026-11-02.

### Features

- **run:** flag stalled runs and refuse starts on overloaded machines [#71](https://github.com/avi2d/orc/pull/71)
- **run:** add orc merge for task PRs on captain word or yolo green [#70](https://github.com/avi2d/orc/pull/70)
- **run:** per-project delivery modes with direct-PR [#69](https://github.com/avi2d/orc/pull/69)
- **run:** add scout and task kinds that end in a report [#68](https://github.com/avi2d/orc/pull/68)

## 0.7.0

Released 2026-11-02.

### Features

- **run:** park a run on open questions and resume it on the answer [#66](https://github.com/avi2d/orc/pull/66)
- **run:** hold backlog tasks for captain decision until answered [#65](https://github.com/avi2d/orc/pull/65)
- **run:** load orchestrator rules in orc chat [#64](https://github.com/avi2d/orc/pull/64)

### Fixes

- **run:** post every unposted closed task once across chat restarts [#62](https://github.com/avi2d/orc/pull/62)
- **run:** print usage for --help after any subcommand [#59](https://github.com/avi2d/orc/pull/59)

## 0.6.0

Released 2026-11-02.

### Features

- **run:** post closed chat tasks back into orc chat with outcome and PR [#55](https://github.com/avi2d/orc/pull/55)
- **run:** add orc chat on the orchestrator model with backlog tools [#54](https://github.com/avi2d/orc/pull/54)
- **dispatch:** read the task for orc backlog add from stdin on - [#53](https://github.com/avi2d/orc/pull/53)
- **run:** keep the run PR link on the closed task [#52](https://github.com/avi2d/orc/pull/52)

### Fixes

- **quota:** show message when no provider is set up [#57](https://github.com/avi2d/orc/pull/57)
- **ledger:** pass each message to the classifier on stdin, not in argv [#51](https://github.com/avi2d/orc/pull/51)
- **lint:** put the real bun and node ahead of mise shims on the lint PATH [#50](https://github.com/avi2d/orc/pull/50)
- **run:** name the fault in an unread quota document [#48](https://github.com/avi2d/orc/pull/48)

## 0.5.0

Released 2026-10-31.

### Features

- **run:** run Pi on a provider its configured Pi packages bring [#43](https://github.com/avi2d/orc/pull/43)

### Fixes

- **tasks:** read the remote machine's pipelines in printed views [#46](https://github.com/avi2d/orc/pull/46)
- make lint and test checks pass on Mac [#45](https://github.com/avi2d/orc/pull/45)
- **run:** skip stdin read on runner result without a label [#44](https://github.com/avi2d/orc/pull/44)

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
