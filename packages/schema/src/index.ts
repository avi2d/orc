export { acceptsExit, type Command, CommandAbsent, CommandRunner, CommandUnreachable } from "./shared/lib";
export { decodeJson, decodeValue, type Decoded, decoded, flatMapDecoded, rejected } from "./shared/lib";
export {
  failureOf,
  type Failed,
  mapOutcome,
  ok,
  type Outcome,
  type Reading,
  unreachable,
  zipOutcomes,
} from "./shared/lib";
export { runDecoded, sourceOf, stamped, type Source } from "./shared/lib";
export * from "./entities/resources";
export {
  type SavedProfile,
  SavedProfilesSource,
  type SavedProfiles,
  savedProfilesSourceLayer,
  decodeSavedProfiles,
} from "./entities/session-quota";
export {
  decodeQuota,
  QuotaAvailability,
  type QuotaProvider,
  type QuotaProviderEntry,
  type QuotaProviderId,
  QuotaProviderState,
  type QuotaReport,
  QuotaSource,
  QuotaWindow,
  quotaSourceLayer,
  shownQuotaProviders,
} from "./entities/session-quota";
export { logFreshMillis, type QuotaRead, readQuota, savedAgeSeconds, staleSavedAgeSeconds, staleSourceAgeSeconds } from "./entities/session-quota";

export {
  type MachineSize,
  type OwnedProcess,
  overLimits,
  ownedProcesses,
  type TaskFolders,
  type TaskLimits,
  type TaskResources,
  taskResources,
  totalSecondsOf,
} from "./entities/task";
export {
  type CountedProcess,
  decodeLinuxTaskProcesses,
  decodeMacTaskProcesses,
  linuxTaskProcessesSourceLayer,
  type LiveProcess,
  macTaskProcessesSourceLayer,
  type ProcessSamples,
  TaskProcessesSource,
} from "./entities/task";
export { outcomeOf } from "./shared/lib";
export { macRusageReader } from "./entities/task";
export * from "./entities/queues";
export { type SnapshotFields, SnapshotReport, type SnapshotSource, snapshotSources } from "./features/snapshot";
export {
  AlertEvent,
  AlertSettings,
  decodeAlertSettings,
  defaultAlertSettings,
  type HeavyLoadSettings,
  type LongTaskSettings,
  type MachineLimits,
  type MemoryLimit,
} from "./entities/alerts";
export { heavyLoadStart, heavyLoadStep, type MachineResources } from "./entities/alerts";
export { longTaskStart, longTaskStep, type MachineTasks } from "./entities/alerts";
export { quotaPaceStart, quotaPaceStep } from "./entities/alerts";
export { type ConfigFile, ConfigRefused, configPath, decodeConfigText, readAlertSettings, readClaudeAccounts, readConfig, readConfigFile } from "./entities/alerts";
export { type DashConfig, strictly } from "./shared/config";
export { type AlertRule, alertRules, AlertVerdictRecord, decodeVerdictLine, type VerdictEntry } from "./entities/alerts";
export { alertVerdictsPath, type VerdictLog, verdictLogReaderAt } from "./entities/alerts";
export { judgesFire, type RuleFire, type RuleRecord, ruleRecords, type RuleVerdict } from "./entities/alerts";
export {
  decodeTasksReport,
  type Hold,
  type Orchestrator,
  type OverheadEntry,
  type PlannedEntry,
  type ReportedTasks,
  reportedTasksOf,
  type ScheduleEntry,
  type TaskEntry,
  TasksReport,
  tasksReport,
  type TaskState,
  type TasksView,
} from "./entities/task";
export {
  encodeTaskSample,
  type SampledProcess,
  type SampledSpend,
  type SampledTask,
  type SampledTestRun,
  TaskSampleRecord,
  taskSampleRecords,
  type TaskUsage,
} from "./entities/task-board";
export { LiveTasksReport } from "./entities/task-board";
export { type GateHold, gateHoldOf } from "./entities/task-pipeline";
export { decodeLiveTasksReport, liveTasksReport } from "./entities/task-board";
export { historyDays, type TaskSamples, TaskSamplesSource, taskSamplesAt, taskSamplesSourceLayer } from "./entities/task-board";
export { type KeptProcess, keptCpuSeconds, type LimitEpisode, type MachineLimit, type ResolvedDetail, resolvedOf, type TaskHistory, taskHistories } from "./entities/task-board";
export {
  atInterval, doneNewestFirst, type Interval,
  isLive,
  type LiveTasks,
  type LiveUsage,
  type ProjectRow,
  runsWork,
  type ShownState,
  type SourceFailure,
  type TaskLevelReadings,
  type TaskLevels,
  type TaskListing,
  taskLevels,
  type TaskProcessRow,
  type TaskRow,
  projectNameOf,
} from "./entities/task-board";
export { mergedTaskLevels, unsetTaskLevels } from "./entities/task-board";
export { type PlannedRow, type PlannedState, plannedStateOf } from "./entities/task";
export { decodeNoMistakes, type NoMistakesRun, type NoMistakesSnapshot, type NoMistakesStep } from "./entities/task-pipeline";
export { decodeOrcRuns, decodeOrcShow, type OrcRun, type OrcSnapshot, type OrcStage } from "./entities/task-pipeline";
export { anchorOf, checksOf, cueMarkOf, cuePipelineOf, detailWithoutWaitsOf, donePipelineOf, fixRoundOf, fullReviewPipelineOf, kindOf, markGlyphOf, modelBadgeOf, noMistakesRunOf, orcPipelineOf, orcRunOf, type PipelineFolder, pipelineFoldersOf, type PipelineKind, pipelineKinds, type PipelineStage, rebuildStage, stageMarkNames, type StageMark, stageNamesOf, summaryOf, type TaskDerivedState, type TaskPipeline, unknownPipelineOf, waitsOnOf } from "./entities/task-pipeline";
export { longStageOf, type Staleness, stalenessOf } from "./entities/task-board";

export { LocalTasks, localTasksLayer, localTasksLayerWithin, type TasksMachine, TasksMachines, tasksMachinesLayer, watchedLocalTasksLayerWithin, watchedRead } from "./entities/task";
export { type TaskHistoryMachine, RemoteTaskHistory, remoteTaskHistoryLayer } from "./entities/task-board";
export { type TaskLiveMachine, RemoteTaskLive, remoteTaskLiveLayer } from "./entities/task-board";
export { readBeside } from "./shared/config";

export { composedSessionQuotaOf, localSessionQuotaOf, type QuotaReadings, type QuotaReadSources, quotaReadSourcesLayer, readQuotas } from "./entities/session-quota";
export { sessionQuotaOf, type SessionQuotaSources, sessionQuotaSourcesLayer, type SessionSources, sessionSourcesLayer } from "./entities/session-quota";
export { ComposedSessionQuotaReport } from "./entities/session-quota";
export { composedSessionQuotaReport } from "./entities/session-quota";
export { sessionQuotaViewOf } from "./entities/session-quota";
export { decodeRemoteSessionQuota, type RemoteSessionSource, SessionMachines, sessionMachinesLayer } from "./entities/session-quota";
export { composedSessionQuota, type RemoteReading } from "./entities/session-quota";
export { type Estimate } from "./entities/session-quota";
export {
  SessionQuotaAlert,
  sessionQuotaAlerts,
  type SessionQuotaFlag,
  SessionQuotaReport,
} from "./entities/session-quota";
export { sessionQuotaFlags, sessionQuotaReport } from "./entities/session-quota";
export { type Harness, type LogRecord, logRecords, markedLogRecords } from "./entities/session-quota";
export {
  decodeHerdrPanes,
  decodeLinuxHarnessProcesses,
  decodeMacHarnessProcesses,
  type HarnessProcess,
  HarnessProcessSource,
  type HerdrPane,
  HerdrSource,
  herdrSourceLayer,
  linuxHarnessProcessSourceLayer,
  macHarnessProcessSourceLayer,
} from "./entities/session-quota";
export {
  HarvestLogSource,
  harvestLogSourceLayer,
  homeLogRoots,
  type LogRoots,
  type SessionLogs,
  SessionLogSource,
  sessionLogSourceAt,
  sessionLogSourceLayer,
  type SinceByHarness,
} from "./entities/session-quota";
export { type CountedCall, countedCalls, type Ledger, type LogFile } from "./entities/session-quota";
export {
  type LiveContext,
  placeOf,
  type ResolvedSessions,
  resolveSessions,
  type Session,
  type SessionIdentity,
  sessionLabel,
  sessionSuffix,
  tieFolderOf,
  type UnmatchedRuns,
} from "./entities/session-quota";
export { type HarvestedReading, harvestedReadings, type HarvestHarness, type HarvestOrigin } from "./entities/session-quota";
export {
  type Captured,
  type CapturedCall,
  capturedOf,
  CaptureRecord,
  captureRecords,
  type ClaudeHeadlessReadingRecord,
  ClaudeStatuslineInput,
  dayFileOf,
  expiredDayFiles,
  type LedgerFile,
  nothingCaptured,
  PiCallInput,
  piCallRecord,
  retainedDays,
  statuslineRecord,
  withCaptured,
} from "./entities/session-quota";
export { appendCaptured, ledgerReaderAt } from "./entities/session-quota";
export { captureLedgerDirectory, claudeConfigDirectory, claudeLogged, dashboardCacheDirectory, machineNames, selector } from "./shared/config";
export { type SourcedWindow, type WindowSource } from "./entities/session-quota";
export { type AccountJoin } from "./entities/session-quota";
export { type ModelTokens, type SessionModels } from "./entities/session-quota";
export { type FairShare, type TaskSpend, taskSpend } from "./entities/task-board";
export {
  type AccountView,
  type Composition,
  type FailedAccount,
  type HeadlessFolder,
  type PanePresence,
  type RemoteMachine,
  type RemoteState,
  type SessionQuotaInputs,
  type SessionQuotaReadings,
  sessionQuotaFrom,
  type SessionQuotaView,
  type SessionShare,
  sessionLogsSince,
  sessionQuotaView,
  type Unmetered,
  type WindowView,
} from "./entities/session-quota";
export {
  addTokens,
  noTokens,
  priceRatios,
  sumTokens,
  type Tokens,
  tokenTotal,
  type Weighting,
  weightings,
} from "./entities/session-quota";

export {
  type AgentSchedule,
  type CronSchedule,
  cronRead,
  decodeAgents,
  decodeTimers,
  decodeWorkflowCrons,
  decodeInactiveWorkflows,
  decodeWorkflowFolder,
  type MachineSchedule,
  MachineSchedules,
  machineSchedulesLayer,
  type MachineSchedulesReading,
  type ScheduleHost,
  type ScheduleRead,
  type ScheduleSource,
  type TimerSchedule,
} from "./entities/schedules";
export { type CalendarPattern, cronPattern, everyValue, nextMatch } from "./entities/schedules";
export { type NamedOrchestrator, type NamedPueue, type NextKind, type NextReadings, type NextRow, type NextSource, type NextSourceState, type NextUp, nextUp, type OrchestratorRead } from "./entities/schedules";

export { type DispatchReading, type DispatchSnapshot, DispatchSource, dispatchSourceLayer, type DispatchTask, missingBacklog } from "./entities/dispatch";
export { type DispatchView, dispatchView, type RoomEntry, type RunRow, type WaitRow } from "./entities/dispatch";

export { type AttentionItem, type AttentionQueue, AttentionSource, attentionSourceLayer } from "./entities/dispatch";

export { type NoMistakesMachine, NoMistakesMachines, noMistakesMachinesLayer, type OrcMachine, OrcMachines, orcMachinesLayer } from "./entities/task-pipeline";

export { quotaBlocks, type QuotaBlock, type QuotaBlockBody, type SavedAge, type SavedWindow } from "./entities/session-quota";
export * from "./features/panel-feeds";
