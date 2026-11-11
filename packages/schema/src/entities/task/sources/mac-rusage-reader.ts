// proc_pid_rusage reads a zombie, so a pid it fails on that kill finds gone was reaped.
// The reader takes pid and parent pairs and reads each parent before its children, and reads a parent and its children
// again when one of them is gone, so a pid with no line was reaped into the time of the nearest parent it printed.
export const macRusageReader = `import { dlopen, FFIType, suffix } from 'bun:ffi';
const lib = dlopen('libproc.' + suffix, { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 }, mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 } });
const rusageV2 = 2; const ownUser = 16; const ownSystem = 24; const childUser = 96; const childSystem = 104;
const base = new Uint8Array(8);
if (lib.symbols.mach_timebase_info(base) !== 0) process.exit(1);
const info = new DataView(base.buffer);
const secondsPerTick = info.getUint32(0, true) / info.getUint32(4, true) / 1e9;
const listed = Bun.argv.slice(1).map(Number);
const pids = new Set(listed.filter((id, index) => index % 2 === 0));
const kids = new Map();
for (let index = 0; index < listed.length; index += 2) {
  const id = listed[index];
  const above = pids.has(listed[index + 1]) && listed[index + 1] !== id ? listed[index + 1] : -1;
  kids.set(above, [...(kids.get(above) ?? []), id]);
}
const read = (id) => {
  const raw = new Uint8Array(256);
  if (lib.symbols.proc_pid_rusage(id, rusageV2, raw) === 0) {
    const fields = new DataView(raw.buffer);
    const seconds = (first, second) => (Number(fields.getBigUint64(first, true) + fields.getBigUint64(second, true)) * secondsPerTick).toFixed(6);
    return 'rusage ' + id + ' ' + seconds(ownUser, ownSystem) + ' ' + seconds(childUser, childSystem);
  }
  try { process.kill(id, 0); } catch (error) { if (error.code === 'ESRCH') return undefined; }
  return 'unread ' + id;
};
const gone = new Set();
const visit = (id) => {
  for (;;) {
    const own = id === -1 ? 'unread' : read(id);
    if (own === undefined) { gone.add(id); return undefined; }
    const lines = id === -1 ? [] : [own];
    const queue = [...(kids.get(id) ?? [])];
    let stale = false;
    while (queue.length > 0 && !stale) {
      const kid = queue.shift();
      if (gone.has(kid)) { queue.push(...(kids.get(kid) ?? [])); continue; }
      const below = visit(kid);
      if (below !== undefined) lines.push(...below);
      else if (own.startsWith('rusage')) stale = true;
      else queue.push(...(kids.get(kid) ?? []));
    }
    if (!stale) return lines;
  }
};
for (const line of visit(-1)) console.log(line);`;
