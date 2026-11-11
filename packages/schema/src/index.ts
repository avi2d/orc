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
export { hostSource, LoadAverage, probe } from "./entities/resources";
export {
  decodeArcStats,
  decodeLoadavg,
  decodeMeminfo,
  decodeOnlineCpus,
  decodeCpuUsage,
  type CpuUsage,
  cpuFieldsOf,
  CpuSample,
  cpuUsageBetween,
  type LinuxHost,
  type LinuxMemInfo,
  LinuxHostSource,
  linuxHostSourceLayer,
} from "./entities/resources";
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
  decodeLinuxProcesses,
  decodeProcesses,
  LinuxProcessesSource,
  linuxProcessesSourceLayer,
  MacProcessesSource,
  macProcessesSourceLayer,
  linuxProcessesCommand,
  type ProcessRow,
} from "./entities/resources";
export {
  decodeComputeApps,
  decodeGpus,
  type ComputeApp,
  type GpuMetric,
  type GpuReading,
  type GpuRow,
  GpuSource,
  gpuSourceLayer,
} from "./entities/resources";
export {
  decodeDf,
  type DiskUsage,
  LinuxDiskSource,
  linuxDiskSourceLayer,
  MacDiskSource,
  macDiskSourceLayer,
} from "./entities/resources";
export {
  decodeSysctl,
  decodeTopCpu,
  decodeVmStat,
  type MacHost,
  MacHostSource,
  macHostSourceLayer,
  type MacSysctl,
  type MacTopCpu,
  type MacVmStat,
} from "./entities/resources";
export {
  type CpuView,
  type DiskView,
  type GpuAppView,
  type GpusView,
  type GpuView,
  type HostReading,
  type LoadAverages,
  type MachineState,
  type MachinesView,
  machinesView,
  machineView,
  type MachineView,
  type Measured,
  type MemoryView,
  type NamedMachine,
  type ProcessView,
  type RemoteResources,
  remoteMachine,
  type ReportedResources,
  type ResourceReadings,
  isFreshResources,
  machineTaskResources,
  resourcesView,
  type ResourcesView,
} from "./entities/resources";
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
export { ResourcesReport } from "./entities/resources";
export { decodeResourcesReport, resourcesReport } from "./entities/resources";
export { QueuesReport } from "./entities/queues";
export { queuesReport } from "./entities/queues";
export { type SnapshotFields, SnapshotReport, type SnapshotSource, snapshotSources } from "./contract/snapshot";
export {
  AlertEvent,
  AlertSettings,
  decodeAlertSettings,
  defaultAlertSettings,
  type HeavyLoadSettings,
  type LongTaskSettings,
  type MachineLimits,
  type MemoryLimit,
} from "./contract/alerts";
export { heavyLoadStart, heavyLoadStep, type MachineResources } from "./alerts/heavy-load";
export { longTaskStart, longTaskStep, type MachineTasks } from "./alerts/long-task";
export { quotaPaceStart, quotaPaceStep } from "./alerts/quota-pace";
export { type ConfigFile, ConfigRefused, configPath, decodeConfigText, readAlertSettings, readClaudeAccounts, readConfig, readConfigFile } from "./sources/config-file";
export { type DashConfig, strictly } from "./shared/config";
export { type AlertRule, alertRules, AlertVerdictRecord, decodeVerdictLine, type VerdictEntry } from "./contract/alert-verdicts";
export { alertVerdictsPath, type VerdictLog, verdictLogReaderAt } from "./sources/alert-verdicts";
export { judgesFire, type RuleFire, type RuleRecord, ruleRecords, type RuleVerdict } from "./views/alert-rules";
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
} from "./contract/task-samples";
export { LiveTasksReport } from "./contract/task-live";
export { type GateHold, gateHoldOf } from "./entities/task-pipeline";
export { decodeLiveTasksReport, liveTasksReport } from "./views/task-levels";
export { historyDays, type TaskSamples, TaskSamplesSource, taskSamplesAt, taskSamplesSourceLayer } from "./sources/task-samples";
export { type KeptProcess, keptCpuSeconds, type LimitEpisode, type MachineLimit, type ResolvedDetail, resolvedOf, type TaskHistory, taskHistories } from "./views/task-history";
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
} from "./views/task-levels";
export { mergedTaskLevels, unsetTaskLevels } from "./views/merged-task-levels";
export { type PlannedRow, type PlannedState, plannedStateOf } from "./entities/task";
export { decodeNoMistakes, type NoMistakesRun, type NoMistakesSnapshot, type NoMistakesStep } from "./entities/task-pipeline";
export { decodeOrcRuns, decodeOrcShow, type OrcRun, type OrcSnapshot, type OrcStage } from "./entities/task-pipeline";
export { anchorOf, checksOf, cueMarkOf, cuePipelineOf, detailWithoutWaitsOf, donePipelineOf, fixRoundOf, fullReviewPipelineOf, kindOf, markGlyphOf, modelBadgeOf, noMistakesRunOf, orcPipelineOf, orcRunOf, type PipelineFolder, pipelineFoldersOf, type PipelineKind, pipelineKinds, type PipelineStage, rebuildStage, stageMarkNames, type StageMark, stageNamesOf, summaryOf, type TaskDerivedState, type TaskPipeline, unknownPipelineOf, waitsOnOf } from "./entities/task-pipeline";
export { longStageOf, type Staleness, stalenessOf } from "./views/stage-time";
export { readableTestNameOf } from "./entities/queues";
export { ResourceMachines, resourceMachinesLayer } from "./entities/resources";
export { LocalTasks, localTasksLayer, localTasksLayerWithin, type TasksMachine, TasksMachines, tasksMachinesLayer, watchedLocalTasksLayerWithin, watchedRead } from "./entities/task";
export { type TaskHistoryMachine, RemoteTaskHistory, remoteTaskHistoryLayer } from "./sources/remote-task-samples";
export { type TaskLiveMachine, RemoteTaskLive, remoteTaskLiveLayer } from "./views/remote-task-live";
export { readBeside } from "./shared/config";
export { type HostSources, hostSourcesLayer, readLocalResources, readMachines } from "./entities/resources";
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
export { type FairShare, type TaskSpend, taskSpend } from "./views/task-spend";
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
  ActionRun,
  ActionsSource,
  actionsSourceLayer,
  activeRuns,
  decodeActions,
} from "./entities/queues";
export { decodeRunnerRepos, jsonObjects, RunnerRepos, runnerReposLayer, type RunnerReposReading } from "./entities/queues";
export {
  type CiReport,
  type CiRun,
  CiRuns,
  ciRunsLayer,
  type CiRunsReading,
  type CiStatus,
  decodeCiJobs,
  decodeCiRuns,
  jobSpan,
  type JobSpan,
  type RepoFailure,
} from "./entities/queues";
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
} from "./sources/schedules";
export { type CalendarPattern, cronPattern, everyValue, nextMatch } from "./sources/calendar";
export { type NamedOrchestrator, type NamedPueue, type NextKind, type NextReadings, type NextRow, type NextSource, type NextSourceState, type NextUp, nextUp, type OrchestratorRead } from "./views/next-up";
export { machineQueue, type MachineQueueView, type QueueEntry, type QueueRow, type QueueRowState, queueWindow } from "./entities/queues";
export { type DispatchReading, type DispatchSnapshot, DispatchSource, dispatchSourceLayer, type DispatchTask, missingBacklog } from "./entities/dispatch";
export { type DispatchView, dispatchView, type RoomEntry, type RunRow, type WaitRow } from "./entities/dispatch";
export { heavySummary, isHeavyNotSetup } from "./entities/queues";
export { type AttentionItem, type AttentionQueue, AttentionSource, attentionSourceLayer } from "./entities/dispatch";
export { decodeHeavyCheck, HeavyCheck, type HeavyMachine, HeavyMachines, heavyMachinesLayer } from "./entities/queues";
export { decodePueue, knownProjects, type PueueMachine, PueueMachines, pueueMachinesLayer, PueueStatus } from "./entities/queues";
export { type MachineProjects } from "./entities/queues";
export { type NoMistakesMachine, NoMistakesMachines, noMistakesMachinesLayer, type OrcMachine, OrcMachines, orcMachinesLayer } from "./entities/task-pipeline";
export {
  type ActionsView,
  type ActionView,
  copyPathsOfStatus,
  type EndedRow,
  type FailureView,
  type GroupView,
  type MachineQueue,
  projectOf,
  type PueueView,
  pueueView,
  type QueueOutcomes,
  type QueueReadings,
  queuesPending,
  type QueuesView,
  queuesView,
  testsOf,
  type RunningRow,
  type RunOwners,
  type TestRun,
} from "./entities/queues";
export { quotaBlocks, type QuotaBlock, type QuotaBlockBody, type SavedAge, type SavedWindow } from "./entities/session-quota";
export * from "./feeds";
