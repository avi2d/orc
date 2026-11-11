import { DateTime } from "effect";

// Either means a date matching the days or the week days matches, the rule cron applies when both day fields are restricted.
type DayRule = "both" | "either";

export interface CalendarPattern {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekDays: ReadonlySet<number>;
  readonly dayRule: DayRule;
}

const rangeOf = (from: number, to: number, step = 1): ReadonlyArray<number> =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);

export const everyValue = (from: number, to: number): ReadonlySet<number> => new Set(rangeOf(from, to));

const wholeNumber = /^\d+$/u;

const numberIn = (text: string, least: number, most: number): number | undefined => {
  if (!wholeNumber.test(text)) return undefined;
  const value = Number(text);
  return value >= least && value <= most ? value : undefined;
};

const partValues = (part: string, least: number, most: number): ReadonlyArray<number> | undefined => {
  const pieces = part.split("/");
  if (pieces.length > 2) return undefined;
  const range = pieces.at(0) ?? "";
  const stepText = pieces.at(1);
  const step = stepText === undefined ? 1 : numberIn(stepText, 1, most - least + 1);
  if (step === undefined) return undefined;
  if (range === "*") return rangeOf(least, most, step);
  const bounds = range.split("-");
  if (bounds.length > 2) return undefined;
  const fromText = bounds.at(0) ?? "";
  const toText = bounds.at(1);
  const from = numberIn(fromText, least, most);
  if (from === undefined) return undefined;
  if (toText === undefined) return stepText === undefined ? [from] : rangeOf(from, most, step);
  const to = numberIn(toText, from, most);
  return to === undefined ? undefined : rangeOf(from, to, step);
};

const fieldValues = (field: string, least: number, most: number): ReadonlySet<number> | undefined => {
  const values: Array<number> = [];
  for (const part of field.split(",")) {
    const each = partValues(part, least, most);
    if (each === undefined) return undefined;
    values.push(...each);
  }
  return new Set(values);
};

const sundays = (weekDays: ReadonlySet<number>): ReadonlySet<number> => new Set([...weekDays].map((day) => day % 7));

const monthNames: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const weekDayNames: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const withNames = (field: string, names: Record<string, number>): string =>
  field.replace(/[A-Za-z]+/gu, (word) => String(names[word.toLowerCase()] ?? word));

// Cron counts a day field that starts with * as unrestricted, even one with a step such as */2, so only then do both fields have to match.
export const cronPattern = (expression: string): CalendarPattern | undefined => {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return undefined;
  const [minute = "", hour = "", day = "", month = "", weekDay = ""] = fields;
  const minutes = fieldValues(minute, 0, 59);
  const hours = fieldValues(hour, 0, 23);
  const days = fieldValues(day, 1, 31);
  const months = fieldValues(withNames(month, monthNames), 1, 12);
  const weekDays = fieldValues(withNames(weekDay, weekDayNames), 0, 7);
  if (minutes === undefined || hours === undefined || days === undefined || months === undefined || weekDays === undefined) return undefined;
  return {
    minutes,
    hours,
    days,
    months,
    weekDays: sundays(weekDays),
    dayRule: day.startsWith("*") || weekDay.startsWith("*") ? "both" : "either",
  };
};

interface Parts {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekDay: number;
}

const dayMatches = (pattern: CalendarPattern, parts: Parts): boolean =>
  pattern.dayRule === "either" ? pattern.days.has(parts.day) || pattern.weekDays.has(parts.weekDay) : pattern.days.has(parts.day) && pattern.weekDays.has(parts.weekDay);

const minuteMillis = 60_000;

// A fixed count of minutes to midnight misses the next day's first hour when the clock changes overnight.
const nextLocalDay = (local: DateTime.Zoned): number => DateTime.toEpochMillis(DateTime.startOf(DateTime.add(local, { days: 1 }), "day")) / minuteMillis;

// Far enough for a yearly pattern, so a pattern no date ever matches, such as the 31st of February, ends the search.
const searchMinutes = 400 * 24 * 60;

// The search skips a whole day or hour that cannot match, so it reads the zone's clock a few hundred times rather than once a minute.
export const nextMatch = (pattern: CalendarPattern, after: DateTime.Utc, zone: DateTime.TimeZone): DateTime.Utc | undefined => {
  const start = Math.floor(DateTime.toEpochMillis(after) / minuteMillis) + 1;
  let minute = start;
  while (minute - start < searchMinutes) {
    const local = DateTime.setZone(DateTime.makeUnsafe(minute * minuteMillis), zone);
    const parts: Parts = DateTime.toParts(local);
    if (!pattern.months.has(parts.month) || !dayMatches(pattern, parts)) minute = nextLocalDay(local);
    else if (!pattern.hours.has(parts.hour)) minute += 60 - parts.minute;
    else if (!pattern.minutes.has(parts.minute)) minute += 1;
    else return DateTime.makeUnsafe(minute * minuteMillis);
  }
  return undefined;
};
