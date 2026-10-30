const helpRequested = (argv: ReadonlyArray<string>): boolean =>
  argv.includes("--help") || argv.includes("-h");

const unknownFlag = (argv: ReadonlyArray<string>, known: ReadonlySet<string>): string | undefined =>
  argv.find((arg) => arg.startsWith("-") && !known.has(arg));

export const usageText = (synopsis: string, description: string, flags: ReadonlyArray<string>): string =>
  ["usage: " + synopsis, "", description, "", ...flags.map((flag) => "  " + flag)].join("\n");

const printPanelFlags: ReadonlyArray<string> = [
  "--print         print one frame and exit instead of running the live panel",
  "--color         emit ANSI colours in the printed frame",
  "--width <n>     frame width in columns",
  "-h, --help      print this usage and exit",
];

export const printPanelKnown: ReadonlySet<string> = new Set(["--print", "--color", "--width", "--help", "-h"]);

export const printColor = (argv: ReadonlyArray<string>): boolean => argv.includes("--color");

export const colorWithoutPrintExit = (argv: ReadonlyArray<string>, usage: string): number | undefined => {
  if (!argv.includes("--color") || argv.includes("--print")) return undefined;
  console.error("Unknown flag: --color\n\n" + usage);
  return 1;
};

export const printPanelUsage = (synopsis: string, description: string): string =>
  usageText(synopsis, description, printPanelFlags);

export const printBinArgsExit = (argv: ReadonlyArray<string>, usage: string, known: ReadonlySet<string>): number | undefined =>
  binArgsExit(argv, usage, known) ?? colorWithoutPrintExit(argv, usage);

export const binArgsExit = (argv: ReadonlyArray<string>, usage: string, known: ReadonlySet<string>): number | undefined => {
  if (helpRequested(argv)) {
    console.log(usage);
    return 0;
  }
  const unknown = unknownFlag(argv, known);
  if (unknown !== undefined) {
    console.error("Unknown flag: " + unknown + "\n\n" + usage);
    return 1;
  }
  return undefined;
};
