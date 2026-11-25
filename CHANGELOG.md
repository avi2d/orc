# Changelog

Every release of `orc`, newest first, written by the release from its conventional commits.

## 0.24.0

Released 2026-11-25.

### Features

- **run:** attach compiled orc builds to each release [#355](https://github.com/avi2d/orc/pull/355)
- **run:** pick models per task with dispatch rules [#354](https://github.com/avi2d/orc/pull/354)

### Fixes

- **run:** let a compiled orc update through its launcher [#357](https://github.com/avi2d/orc/pull/357)
- **run:** settle routine questions and retry runs that died for a retryable reason [#356](https://github.com/avi2d/orc/pull/356)

## 0.23.0

Released 2026-11-25.

### Features

- **run:** run tasks on OpenAI and OpenCode Go subscriptions beside Claude [#352](https://github.com/avi2d/orc/pull/352)
- **run:** update Orc from the dispatch beat [#349](https://github.com/avi2d/orc/pull/349)

## 0.22.0

Released 2026-11-25.

### Features

- **run:** build the heavy stand-in as a Bun bytecode binary [#345](https://github.com/avi2d/orc/pull/345)
- **run:** close parked tasks whose work merged elsewhere [#348](https://github.com/avi2d/orc/pull/348)
- **herdr-app:** show user-owned attention with answers on the card [#347](https://github.com/avi2d/orc/pull/347)
- **run:** merge a done task's green PR by itself on yolo projects [#338](https://github.com/avi2d/orc/pull/338)
- **herdr-app:** replace Runs filter chips with Project and Status selects [#341](https://github.com/avi2d/orc/pull/341)

### Fixes

- **run:** read bundled assets from the compiled orc [#340](https://github.com/avi2d/orc/pull/340)
- **run:** reuse a completed review when a resumed direct-PR run's branch is unchanged [#342](https://github.com/avi2d/orc/pull/342)

## 0.21.0

Released 2026-11-24.

### Features

- **run:** refuse test runners called by node_modules/.bin path [#332](https://github.com/avi2d/orc/pull/332)
- **schema:** read account names from orc quota --json, drop clauth profiles [#336](https://github.com/avi2d/orc/pull/336)
- **run:** compile orc to a Bun bytecode file that spawns itself [#331](https://github.com/avi2d/orc/pull/331)
- **run:** refuse node --test, pytest, make test, deno test and cargo t runners [#334](https://github.com/avi2d/orc/pull/334)
- **herdr-app:** add Summary view for Checks steps in the Agents tab [#335](https://github.com/avi2d/orc/pull/335)
- **run:** add agent wrappers that refuse test runners in no-mistakes agents [#327](https://github.com/avi2d/orc/pull/327)

### Fixes

- **run:** count review logs as run output [#337](https://github.com/avi2d/orc/pull/337)
- **run:** pass the tool-time-cap extension to agents in the nono sandbox [#330](https://github.com/avi2d/orc/pull/330)
- **quota:** drop clauth saved-profiles source from the dashboard quota panel [#329](https://github.com/avi2d/orc/pull/329)
- **run:** route review questions to the decider by the owner action they ask for [#328](https://github.com/avi2d/orc/pull/328)

## 0.20.0

Released 2026-11-24.

### Features

- **quota:** show orc quota accounts in the dashboard quota panel [#324](https://github.com/avi2d/orc/pull/324)
- **run:** merge a behind PR without update if no files shared, alarm on failed main CI [#322](https://github.com/avi2d/orc/pull/322)
- **run:** print the beat quota with orc quota --json [#319](https://github.com/avi2d/orc/pull/319)
- **run:** run a recorded review turn in direct-PR delivery [#310](https://github.com/avi2d/orc/pull/310)
- **run:** refuse test runners in --sandbox none Pi sessions through the heavy stand-in [#308](https://github.com/avi2d/orc/pull/308)
- **run:** answer review questions by their Recommended: line [#315](https://github.com/avi2d/orc/pull/315)
- **run:** drop session/agent once a run ends done or failed [#314](https://github.com/avi2d/orc/pull/314)
- **run:** let the beat pick an account across Claude, OpenAI and OpenCode [#312](https://github.com/avi2d/orc/pull/312)
- **run:** read beat quota from subquo read --json snapshot [#300](https://github.com/avi2d/orc/pull/300)
- **run:** refuse local test runners inside the default nono sandbox [#307](https://github.com/avi2d/orc/pull/307)
- **trials:** show task wait state and pull request link on bb Board page [#305](https://github.com/avi2d/orc/pull/305)

### Fixes

- **run:** refuse test runners in Orc run steps with PATH-first stand-ins [#323](https://github.com/avi2d/orc/pull/323)
- **run:** leave clean behind branches alone during Orc delivery [#321](https://github.com/avi2d/orc/pull/321)
- **run:** judge decider never-decide guard by intent not single words [#320](https://github.com/avi2d/orc/pull/320)
- **run:** hold repeat resumes that park with nothing new [#309](https://github.com/avi2d/orc/pull/309)
- **trials:** run the bb trial beside the captain's own bb settings [#318](https://github.com/avi2d/orc/pull/318)
- **herdr-app:** show what Awaiting you cards need [#317](https://github.com/avi2d/orc/pull/317)
- **herdr-app:** show settled runs and configured projects [#316](https://github.com/avi2d/orc/pull/316)
- **run:** park an unchanged gate for the owner instead of restarting it [#313](https://github.com/avi2d/orc/pull/313)
- **trials:** build the orc Board bb plugin inside its own folder [#311](https://github.com/avi2d/orc/pull/311)
- **run:** leave repository tests to GitHub CI [#304](https://github.com/avi2d/orc/pull/304)
- **run:** tolerate punctuation differences in decider rule quotes [#303](https://github.com/avi2d/orc/pull/303)

## 0.19.0

Released 2026-11-23.

### Features

- **run:** derive each board task next action from backlog JSON [#296](https://github.com/avi2d/orc/pull/296)
- **run:** sign opencode in with orc login in its own account folder [#287](https://github.com/avi2d/orc/pull/287)
- **run:** sign claude-second in through a private browser window [#288](https://github.com/avi2d/orc/pull/288)
- **run:** add openai sign-in through Codex login [#286](https://github.com/avi2d/orc/pull/286)
- **run:** add orc login with per-account folders and Claude sign-in [#263](https://github.com/avi2d/orc/pull/263)
- **docs:** keep map node text under 40 characters, with details in the control [#282](https://github.com/avi2d/orc/pull/282)
- **docs:** add details control to every map node [#280](https://github.com/avi2d/orc/pull/280)
- **herdr-app:** open Inbox from Awaiting you counts [#277](https://github.com/avi2d/orc/pull/277)
- **run:** gate direct PR runs on GitHub CI check verdict [#271](https://github.com/avi2d/orc/pull/271)
- **run:** require outcomes and recommendation on orc_ask questions [#272](https://github.com/avi2d/orc/pull/272)
- **run:** report the decider's recommended option and mark it in the Inbox [#268](https://github.com/avi2d/orc/pull/268)
- **run:** give beat attention items subject, options with outcomes and recommendation [#270](https://github.com/avi2d/orc/pull/270)

### Fixes

- **run:** fall back to project tool when heavy stand-in has no recorded path [#290](https://github.com/avi2d/orc/pull/290)
- **run:** pin platform-node-shared so packed CLI starts after clean install [#289](https://github.com/avi2d/orc/pull/289)
- **run:** prove scoped tarball with npm pack and use object repository form [#285](https://github.com/avi2d/orc/pull/285)
- **run:** report overturned answers as undelivered and narrow decider quotes [#281](https://github.com/avi2d/orc/pull/281)
- **run:** recover grabs after owner pid reuse [#269](https://github.com/avi2d/orc/pull/269)

## 0.18.0

Released 2026-11-20.

### Features

- **run:** take implementer and fixer thinking levels from the beat [#261](https://github.com/avi2d/orc/pull/261)
- **herdr-app:** add Inbox tab on cmd-4 with answer and Approve actions [#265](https://github.com/avi2d/orc/pull/265)
- **run:** add reviewer agent with bundled prompt and override chain [#266](https://github.com/avi2d/orc/pull/266)
- **chat:** add attention queue read and answer tools [#260](https://github.com/avi2d/orc/pull/260)
- **run:** add orc update to install the newest published orc [#259](https://github.com/avi2d/orc/pull/259)
- **run:** report the orc version running on each machine [#256](https://github.com/avi2d/orc/pull/256)
- **run:** add chat tools for stop, drop, send-back, note, depend and thread [#255](https://github.com/avi2d/orc/pull/255)
- **run:** orc merge updates a PR behind its base and merges after checks pass [#234](https://github.com/avi2d/orc/pull/234)
- **docs:** give map colours one meaning each and add a legend [#247](https://github.com/avi2d/orc/pull/247)
- **docs:** open docs pages from the home scheme and link the map in its bar [#245](https://github.com/avi2d/orc/pull/245)
- **docs:** keep several map blocks open and correct run question paths [#244](https://github.com/avi2d/orc/pull/244)
- **docs:** give the docs site the watercolor paper look [#243](https://github.com/avi2d/orc/pull/243)
- **docs:** give the docs site the Paint look [#240](https://github.com/avi2d/orc/pull/240)
- **herdr-app:** add inbox model for open questions, decisions, holds and PR approvals [#238](https://github.com/avi2d/orc/pull/238)
- **run:** read quota-axi per-provider JSON in beat quota reader [#232](https://github.com/avi2d/orc/pull/232)
- **run:** hand the implementer and fixer models from the beat to orc run [#225](https://github.com/avi2d/orc/pull/225)

### Fixes

- **run:** keep flags out of backlog answer words [#262](https://github.com/avi2d/orc/pull/262)
- **run:** park unanswerable review findings and gate cap as questions [#258](https://github.com/avi2d/orc/pull/258)
- **run:** answer repeated parked question on its open entry [#235](https://github.com/avi2d/orc/pull/235)
- **run:** accept decider quotes that sit inside a longer line [#233](https://github.com/avi2d/orc/pull/233)
- **docs:** hide the heading anchor on every h1 [#249](https://github.com/avi2d/orc/pull/249)
- **herdr-app:** scroll each Board column on its own [#236](https://github.com/avi2d/orc/pull/236)
- **run:** group resumed run carried steps under their origin run [#230](https://github.com/avi2d/orc/pull/230)

## 0.17.0

Released 2026-11-15.

### Features

- **herdr-app:** open every Pi session step in Turns with numbered turns and calls [#227](https://github.com/avi2d/orc/pull/227)
- **herdr-app:** show full backlog thread with answerable picture options [#219](https://github.com/avi2d/orc/pull/219)

### Fixes

- **herdr-app:** show queue position for tasks waiting in pueue [#229](https://github.com/avi2d/orc/pull/229)
- **herdr-app:** open PR addresses in the default browser on click [#226](https://github.com/avi2d/orc/pull/226)
- **herdr-app:** show Board task panel only for the selected card [#224](https://github.com/avi2d/orc/pull/224)
- **run:** recover tasks left under grabbed names by killed processes [#222](https://github.com/avi2d/orc/pull/222)
- **run:** park a re-asked question once so one answer resumes the task [#218](https://github.com/avi2d/orc/pull/218)
- **run:** set orc pueue group parallel limit from machine slots [#223](https://github.com/avi2d/orc/pull/223)
- **run:** guard look, legal and login questions and answer recommended options [#216](https://github.com/avi2d/orc/pull/216)

## 0.16.0

Released 2026-11-15.

### Features

- **herdr-app:** agents turns view, changes column, and approve and merge [#215](https://github.com/avi2d/orc/pull/215)
- **herdr-app:** show the selected task in a task panel [#214](https://github.com/avi2d/orc/pull/214)
- **run:** add orc backlog send-back for a PR that needs one more pass [#213](https://github.com/avi2d/orc/pull/213)
- **run:** let the decider read the owner's rules and never have the last word [#211](https://github.com/avi2d/orc/pull/211)
- **herdr-app:** open orc chat in a cmd-k drawer with Raw and Turns views [#207](https://github.com/avi2d/orc/pull/207)
- **run:** report task waiting reason and PR state in backlog JSON [#210](https://github.com/avi2d/orc/pull/210)
- **run:** add --session file to orc chat [#206](https://github.com/avi2d/orc/pull/206)
- **run:** add decision backlog kind for captain-answered questions [#205](https://github.com/avi2d/orc/pull/205)
- **run:** list queued backlog tasks in orc runs JSON [#204](https://github.com/avi2d/orc/pull/204)

### Fixes

- **run:** treat unread PR state as null so closed tasks land in Done [#212](https://github.com/avi2d/orc/pull/212)
- **herdr-app:** start the scratch App with herdr-core found and no focus taken [#208](https://github.com/avi2d/orc/pull/208)

## 0.15.0

Released 2026-11-14.

### Features

- **run:** let a worker ask the captain mid-run with orc_ask [#202](https://github.com/avi2d/orc/pull/202)
- **run:** let the chat set a task priority [#201](https://github.com/avi2d/orc/pull/201)
- **run:** keep tasks with no priority from starting [#199](https://github.com/avi2d/orc/pull/199)
- **run:** include other machines' runs in orc runs --json [#200](https://github.com/avi2d/orc/pull/200)
- **run:** make orc help human friendly [#195](https://github.com/avi2d/orc/pull/195)
- **run:** add state and currentStep to orc runs JSON [#198](https://github.com/avi2d/orc/pull/198)
- **run:** record task, machine, worktree, model and thinking in run history and JSON [#196](https://github.com/avi2d/orc/pull/196)
- **run:** add backlog thread ordered task conversation [#194](https://github.com/avi2d/orc/pull/194)
- **run:** add task priority that orders the beat [#191](https://github.com/avi2d/orc/pull/191)
- **run:** add orc backlog drop to close unwanted new tasks [#192](https://github.com/avi2d/orc/pull/192)
- **run:** add orc backlog origin to record a legacy parked task's run [#193](https://github.com/avi2d/orc/pull/193)
- **run:** add orc backlog edit to replace a new task's text [#188](https://github.com/avi2d/orc/pull/188)
- **herdr-app:** show subscriptions and machines on the Resources tab [#190](https://github.com/avi2d/orc/pull/190)
- **herdr-app:** show backlog lanes on the Board tab [#189](https://github.com/avi2d/orc/pull/189)
- **run:** add orc backlog note command [#186](https://github.com/avi2d/orc/pull/186)
- **run:** record the time a hold is placed and keep it in hold_history [#183](https://github.com/avi2d/orc/pull/183)
- **herdr-app:** show runs, steps, and step output in the Agents tab [#182](https://github.com/avi2d/orc/pull/182)

### Fixes

- **run:** stream check output into the evidence file as it prints [#184](https://github.com/avi2d/orc/pull/184)
- **ci:** run mutation workflow only on manual start [#187](https://github.com/avi2d/orc/pull/187)
- **run:** keep resumed step logs on original evidence and label rails by run id [#185](https://github.com/avi2d/orc/pull/185)
- **run:** build Herdr App bundle during orc app install [#179](https://github.com/avi2d/orc/pull/179)

## 0.14.1

Released 2026-11-13.

### Fixes

- **run:** resume parked runs in place, gate ship merges, and allow re-hold [#180](https://github.com/avi2d/orc/pull/180)

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
