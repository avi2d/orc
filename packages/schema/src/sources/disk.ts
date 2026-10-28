import { Context, Duration, Layer, Schema } from "effect";
import { type Decoded, decoded, decodeValue, flatMapDecoded, rejected } from "../decode";
import type { Source } from "../source";
import { hostSource, probe } from "./host";
import { nonEmptyLines } from "./lines";
import { CountText } from "./numerals";

export interface DiskUsage {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

const DfSize = Schema.Struct({ blocks: CountText, available: CountText });

// df -P keeps each filesystem on one line, so the last line is the volume the path asked about.
const dfLine = /^\S+\s+(\d+)\s+\d+\s+(\d+)\s+\S+\s+.+$/;

export const decodeDf = (stdout: string): Decoded<DiskUsage> => {
  const last = nonEmptyLines(stdout).at(-1);
  if (last === undefined) return rejected("df printed no filesystem line");
  const match = dfLine.exec(last);
  if (match === null) return rejected("the df line does not read as filesystem, blocks, used, free, capacity and mount");
  // The Used column leaves the root reservation and the APFS container's other volumes out of both used and free.
  return flatMapDecoded(decodeValue(DfSize)({ blocks: match[1], available: match[2] }), ({ blocks, available }) =>
    decoded({ usedBytes: (blocks - available) * 1024, totalBytes: blocks * 1024 }),
  );
};

// df / on the Mac reports the sealed system volume, so the home directory names the data volume.
const macDiskCommand = { argv: ["sh", "-c", 'df -kP "$HOME"'], timeout: Duration.seconds(10) } as const;

const linuxDiskCommand = { argv: ["df", "-kP", "/"], timeout: Duration.seconds(10) } as const;

export class MacDiskSource extends Context.Service<MacDiskSource, Source<DiskUsage>>()("tui-dash/MacDiskSource") {}

export const macDiskSourceLayer = Layer.effect(MacDiskSource, hostSource(probe(macDiskCommand, decodeDf)));

export class LinuxDiskSource extends Context.Service<LinuxDiskSource, Source<DiskUsage>>()("tui-dash/LinuxDiskSource") {}

export const linuxDiskSourceLayer = Layer.effect(LinuxDiskSource, hostSource(probe(linuxDiskCommand, decodeDf)));
