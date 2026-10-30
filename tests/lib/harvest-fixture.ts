import { type LogFile, logRecords } from "@tui-dash/schema";
import { fixture } from "./fixtures";

export const rolloutRelative =
  ".codex/sessions/2026/10/13/rollout-2026-10-13T19-00-00-11111111-0000-4000-8000-000000000a01.jsonl";

export const claudeLogRelative = ".claude/projects/-home-tester-notes/dddddddd-0000-4000-8000-00000000d101.jsonl";

export const rolloutPath = `/home/tester/${rolloutRelative}`;

export const claudeLogPath = `/home/tester/${claudeLogRelative}`;

export const rolloutFile = (text = fixture("harvest/codex-rollout.jsonl")): LogFile => ({
  path: rolloutPath,
  harness: "codex",
  modifiedAt: 0,
  records: logRecords("codex", text),
});

export const claudeLogFile = (): LogFile => ({
  path: claudeLogPath,
  harness: "claude-code",
  modifiedAt: 0,
  records: logRecords("claude-code", fixture("harvest/claude-code.jsonl")),
});

// quota-axi read Codex and Claude at 20:18:15 in the recording; this moves both reads before the logs' readings.
export const readBeforeHarvest = (text: string): string =>
  text
    .replace('"refreshedAt": "2026-10-13T20:18:15.337Z"', '"refreshedAt": "2026-10-13T19:30:00.000Z"')
    .replace('"refreshedAt": "2026-10-13T20:18:15.232Z"', '"refreshedAt": "2026-10-13T19:00:00.000Z"');
