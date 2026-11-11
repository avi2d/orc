declare module "herdr" {
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export function exec(command: string, args?: string[], options?: { cwd?: string; on?: string | null; timeout?: number }): Promise<ExecResult>;
export function hc(args: string[]): Promise<ExecResult>;
export function home(): string;
export function appHome(): string;
export function readTextFile(path: string, options?: { on?: string | null }): Promise<string | null>;
export function writeTextFile(path: string, text: string, expected: string | null): Promise<null>;
export function knownAgents(options?: { on?: string | null }): Promise<(Program & { run: string[]; installed: boolean })[]>;
export function pickFolder(options?: { prompt?: string }): Promise<string | null>;
export function playSound(sound: string): null;
export function run(name: string, args?: Record<string, unknown>): null;
export type Status = "working" | "blocked" | "done" | "idle";
export interface TabInfo {
  id: string;
  index: number;
  name: string;
  named: boolean;
  active: boolean;
  status: Status | null;
  panes: number;
  zoomed: boolean;
  settled: boolean;
  settled_at: number | null;
  changed_at: number | null;
  working_since: number | null;
}
export interface SpaceInfo {
  id: string;
  index: number;
  name: string;
  named: boolean;
  folder: string;
  machine: string | null;
  branch: string | null;
  active: boolean;
  status: Status | null;
  tabs: TabInfo[];
}
export function machines(): { name: string | null; layout: "loading" | "ready" | "unavailable" }[];
export function spaces(): SpaceInfo[];
export interface Program {
  key: string;
  name: string;
  icon: string | null;
  tint: boolean;
  tile: string | null;
  color: string | null;
  shell: boolean;
  agent: boolean;
}
export interface AgentInfo {
  address: string;
  pane: string;
  space: string;
  space_name: string;
  tab: string;
  tab_index: number;
  tab_name: string;
  status: Status;
  app: string | null;
  program: Program;
  title: string;
  seq: number;
  pinned: boolean;
  focused: boolean;
}
export function agents(): AgentInfo[];
export interface PaneInfo {
  pane: string;
  terminal: string | null;
  mod?: string;
  tab: string;
  title: string;
  cwd: string | null;
  branch: string | null;
  status: Status | null;
  app: string | null;
  program: Program;
  focused: boolean;
  zoomed: boolean;
  movable: boolean;
}
export function panes(): PaneInfo[];
export function setAgentOrder(addresses: string[]): null;
export function terminals(): any[];
export function focused(): { space: string; tab: string; pane: string | null; terminal: string | null; shown: string | null; agent: string | null; cwd: string | null } | null;
export function layout(): unknown;
export function layouts(): string[];
export function commands(): { name: string; args: { name: string; required: boolean }[]; about: string }[];
export function window(): {
  platform: "linux" | "macos" | "windows";
  titlebar: "system" | "none";
  buttons: boolean;
  maximized: boolean;
  fullscreen: boolean;
  active: boolean;
};
export function placement(): {
  edge: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
  vertical: boolean;
  hovered: boolean;
  dragging: boolean;
} | null;
export function theme(): Record<string, string>;
export function themes(): { name: string; light: boolean; colors: Record<string, string> }[];
export function fonts(): string[];
export function updates(): {
  app: { version: string; ready: string | null; updates: boolean };
  notes: { version: string; date: string; items: { headline: string; detail: string; fixed: boolean; media: { path: string; width: number; height: number }[] }[]; spotlight: boolean }[];
  core: { version: string | null; managed: string | null; ready: string | null; updating: boolean; error: string | null };
  checked: number | null;
  checks: boolean;
  checking: boolean;
};
export function presentUpdateNotes(versions: string[]): null;
export function telemetry(): {
  enabled: boolean;
  setting: boolean;
  off_because: string | null;
  sends: boolean;
  endpoint: string;
  draft: Record<string, unknown> | null;
  queued: Record<string, unknown>[];
  last_sent: { at: number; report: Record<string, unknown> } | null;
} | null;
export function feedbackPreview(message: string, email: string, images?: number): { body: import("gpui-kit").HostValue; available: boolean };
export function feedbackPasteImage(): { path: string } | { error: string } | null;
export function feedbackPickImages(): Promise<({ path: string } | { error: string })[]>;
export function feedbackAttachImages(paths: string[]): ({ path: string } | { error: string })[];
export function feedbackClearImages(): null;
export function sendFeedback(body: import("gpui-kit").HostValue, images?: string[]): Promise<string | null>;
export function settings(): Record<string, unknown>;
export function keys(): { section: string; keys: string; action: string }[];
export interface OverlaySpec {
  mod?: string;
  props?: Record<string, unknown>;
  layout?: unknown;
  kind?: "dialog" | "popup" | "window";
  modal?: boolean;
  frame?: "none";
  key?: string;
  keep?: boolean;
  width?: number;
  height?: number;
  at?: "pointer" | { x: number; y: number };
}
export function openOverlay(spec: OverlaySpec): string;
export function closeOverlay(id: string): null;
export function notify(n: {
  title: string;
  body?: string;
  level?: "info" | "success" | "warning" | "error";
  timeout?: number;
  icon?: string;
  action?: { name: string; args?: Record<string, unknown> };
}): string;
export function props(): any;
export function shared(key: string): unknown;
export function setShared(key: string, value: unknown): null;
export function nextCommand(): Promise<string>;
export function watchFolder(path: string): Promise<string[]>;
}
