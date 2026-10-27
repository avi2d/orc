const quote = String.fromCharCode(34);
const versionOf = (text: string): string => {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null) {
    throw new Error("manifest holds no version");
  }
  const version = (data as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("manifest holds no version");
  }
  return version;
};
const versionBounds = (text: string, searchFrom: number): { end: number; start: number } => {
  const key = quote + "version" + quote;
  const keyAt = text.indexOf(key, searchFrom);
  if (keyAt === -1) {
    throw new Error("version field holds no value");
  }
  const colonAt = text.indexOf(":", keyAt + key.length);
  if (colonAt === -1) {
    throw new Error("version field holds no value");
  }
  const openAt = text.indexOf(quote, colonAt);
  if (openAt === -1) {
    throw new Error("version field holds no value");
  }
  const start = openAt + 1;
  const end = text.indexOf(quote, start);
  if (end === -1) {
    throw new Error("version field holds no value");
  }
  return { end: end, start: start };
};
const rootText = await Bun.file("package.json").text();
const runText = await Bun.file("packages/run/package.json").text();
const lockText = await Bun.file("bun.lock").text();
const rootVersion = versionOf(rootText);
const runBounds = versionBounds(runText, 0);
const runVersion = runText.slice(runBounds.start, runBounds.end);
if (runVersion !== rootVersion) {
  await Bun.write("packages/run/package.json", runText.slice(0, runBounds.start) + rootVersion + runText.slice(runBounds.end));
}
const lockSearch = lockText.indexOf("packages/run");
if (lockSearch === -1) {
  throw new Error("lockfile holds no run package");
}
const lockBounds = versionBounds(lockText, lockSearch);
const lockVersion = lockText.slice(lockBounds.start, lockBounds.end);
if (lockVersion !== rootVersion) {
  await Bun.write("bun.lock", lockText.slice(0, lockBounds.start) + rootVersion + lockText.slice(lockBounds.end));
}
