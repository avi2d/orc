import { DateTime } from "effect";
import {
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
} from "@avi2dg/orc-schema";
import { fixture } from "./fixtures";
import { valueOf } from "./outcomes";
import { orcQuotaReading, orcQuotaText, recordedOrcQuota } from "./orc-quota";
import { quotaAxiRead } from "./quota-read";

export const dashboardNow = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

export const quotaBlocksOf = (quotaText: string, orcQuota: string = orcQuotaText(recordedOrcQuota)): ReadonlyArray<QuotaBlock> => {
  const quota = decodeQuota(quotaText);
  if (quota.kind !== "ok") throw new Error("the fixtures do not decode");
  return quotaBlocks(
    quotaAxiRead({ ...quota, capturedAt: dashboardNow }),
    orcQuotaReading(orcQuota, dashboardNow),
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
