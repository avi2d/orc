const redirections = /(?<=^|\s)\d*[<>]+&?\s*\S+/gu;

const checkWords: ReadonlySet<string> = new Set(["test", "lint", "typecheck", "check", "tsc", "vitest", "jest", "pytest", "eslint"]);

const isFlag = (token: string): boolean => token.startsWith("-") && token !== "-";

const isBareValue = (token: string): boolean => !token.includes("/") && !checkWords.has(token.toLowerCase());

const wordsOf = (segment: string): ReadonlyArray<string> => {
  const words: Array<string> = [];
  let flagTakesValue = false;
  for (const token of segment.replaceAll(redirections, " ").split(/\s+/u)) {
    if (token === "" || token === "-") continue;
    if (isFlag(token)) {
      flagTakesValue = token !== "--" && !token.includes("=");
      continue;
    }
    // A bare word after a flag is the flag's value, while a path or check word is the run's own.
    if (flagTakesValue && isBareValue(token)) {
      flagTakesValue = false;
      continue;
    }
    flagTakesValue = false;
    words.push(token);
  }
  return words;
}

// A path such as tests/unit/scaffold.test.ts names a file the command touches, so only a bare word says the segment runs a check.
const runsCheck = (words: ReadonlyArray<string>): boolean => words.some((word) => checkWords.has(word.toLowerCase()));

const shortNameOf = (words: ReadonlyArray<string>): string =>
  words
    .slice(0, 3)
    .map((word) => word.split("/").findLast((part) => part !== "") ?? word)
    .join(" ");

export const readableTestNameOf = (command: string): string => {
  const segments = command
    .split(/;|&&|\|\||\|/u)
    .map(wordsOf)
    .filter((words) => words.length > 0 && words[0] !== "cd");
  const named = segments.filter(runsCheck);
  const names = [...new Set((named.length === 0 ? segments.slice(0, 1) : named).map(shortNameOf))];
  return names.length === 0 ? command : names.join(" · ");
};
