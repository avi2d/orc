import { DateTime } from "effect";
import {
  decodeSavedProfiles,
  decodeComputeApps,
  decodeCpuUsage,
  decodeDf,
  decodeGpus,
  decodeLinuxProcesses,
  decodeLoadavg,
  decodeMeminfo,
  decodeOnlineCpus,
  decodeQuota,
  decodeResourcesReport,
  ok,
  type QuotaBlock,
  quotaBlocks,
  type ReportedResources,
  type ResourcesView,
  resourcesView,
} from "@tui-dash/schema";
import { fixture } from "./fixtures";
import { valueOf } from "./outcomes";
import { quotaAxiRead } from "./quota-read";

export const dashboardNow = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

export const quotaBlocksOf = (quotaText: string, profiles: (names: ReadonlyArray<string>) => ReadonlyArray<string> = (names) => names): ReadonlyArray<QuotaBlock> => {
  const quota = decodeQuota(quotaText);
  const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
  if (quota.kind !== "ok" || savedProfiles.kind !== "ok") throw new Error("the fixtures do not decode");
  const second = savedProfiles.value.profiles.find((profile) => profile.name === "second");
  if (second === undefined) throw new Error("the saved profiles fixture has no second profile");
  const extra = profiles([]).map((name) => ({ ...second, name }));
  return quotaBlocks(
    quotaAxiRead({ ...quota, capturedAt: dashboardNow }),
    { ...savedProfiles, value: { ...savedProfiles.value, profiles: [...savedProfiles.value.profiles, ...extra] }, capturedAt: dashboardNow },
    dashboardNow,
  );
};

export const recordedResources = (gpuCsv = fixture("linux/gpu.csv")): ResourcesView =>
  resourcesView({
    host: {
      platform: "linux",
      host: {
        ...ok({
          load: valueOf(decodeLoadavg(fixture("linux/loadavg.txt"))),
          cpuCount: valueOf(decodeOnlineCpus(fixture("linux/nprocessors-onln.txt"))),
          cpuUsage: valueOf(decodeCpuUsage(fixture("linux/stat.txt"))),
          memory: valueOf(decodeMeminfo(fixture("linux/meminfo.txt"))),
          arcReclaimableBytes: 0,
        }),
        capturedAt: dashboardNow,
      },
    },
    processes: { ...decodeLinuxProcesses(fixture("linux/proc-stat.txt")), capturedAt: dashboardNow },
    disk: { ...ok(valueOf(decodeDf(fixture("linux/df.txt")))), capturedAt: dashboardNow },
    gpu: {
      ...ok({
        gpus: valueOf(decodeGpus(gpuCsv)),
        apps: decodeComputeApps(fixture("linux/gpu-apps.csv")),
      }),
      capturedAt: dashboardNow,
    },
  });

export const southResources = (): ReportedResources => valueOf(decodeResourcesReport(fixture("resources/south.json")));
