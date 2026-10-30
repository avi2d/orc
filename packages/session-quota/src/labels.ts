import { type Session, type SessionQuotaView, type SessionShare, sessionSuffix } from "@tui-dash/schema";
import { ellipsize, widthOf } from "@tui-dash/ui";
import { combinedNames } from "./notes";

export const machinesOf = (view: SessionQuotaView): ReadonlyArray<string> =>
  view.composition === undefined ? [] : combinedNames(view.composition);

// The suffix tells sessions apart, so the place gives way first, keeping a pool slot such as /4 after its cut.
const placeWithin = (place: string, room: number): string => {
  if (widthOf(place) <= room) return place;
  const slot = place.slice(place.lastIndexOf("/"));
  return place.includes("/") && widthOf(slot) < room - 1
    ? `${ellipsize(place.slice(0, place.lastIndexOf("/")), room - widthOf(slot))}${slot}`
    : ellipsize(place, room);
};

const suffixWithin = (session: Session, room: number): string => {
  const suffix = sessionSuffix(session);
  if (widthOf(suffix) <= room || session.identity.kind !== "process") return ellipsize(suffix, room);
  return ellipsize(`p${session.identity.pid}`, room);
};

const distinctPrefix = (machine: string, machines: ReadonlyArray<string>): string =>
  Array.from({ length: machine.length }, (_, index) => machine.slice(0, index + 1)).find((prefix) =>
    machines.every((name) => name === machine || !name.startsWith(prefix)),
  ) ?? machine;

// The letters that tell a machine apart end its distinct prefix, so a tag cut to its room keeps that prefix's end.
const machineTag = (machine: string, machines: ReadonlyArray<string>, room: number): string => {
  if (widthOf(machine) <= room) return machine;
  const letters = Array.from(distinctPrefix(machine, machines));
  const start = letters.findIndex((_, index) => widthOf(letters.slice(index).join("")) <= room);
  return start === -1 ? "" : letters.slice(start).join("");
};

// Pane ids repeat across machines, so the machine outlasts the place, and the pane id outlasts the machine.
export const labelWithin = (row: SessionShare, room: number, machines: ReadonlyArray<string>): string => {
  const { machine, place } = row.session;
  const suffix = suffixWithin(row.session, room);
  const tag = machine === undefined ? "" : machineTag(machine, machines, room - widthOf(suffix) - 1);
  const lead = tag === "" ? "" : `${tag} `;
  const placeRoom = room - widthOf(lead) - widthOf(suffix) - 1;
  return placeRoom < 3 ? `${lead}${suffix}` : `${lead}${placeWithin(place, placeRoom)} ${suffix}`;
};
