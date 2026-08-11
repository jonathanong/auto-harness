type CronField = {
  any: boolean;
  values: Set<number>;
};

type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const CRON_FIELDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

/** Accept only canonical, unambiguous UTC instants accepted by the schedule API. */
export function isValidUtcTimestamp(value: string): boolean {
  const parts = UTC_TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const millisecond = parts[7] === undefined ? 0 : Number(parts[7]);
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millisecond));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
}

/** Parse a strict five-field numeric cron expression (minute hour day month weekday). */
export function parseCron(expression: string): ParsedCron | null {
  const fields = expression.split(" ");
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) return null;
  const [minuteSource, hourSource, dayOfMonthSource, monthSource, dayOfWeekSource] = fields;
  const minute = parseField(minuteSource!, ...CRON_FIELDS[0]);
  const hour = parseField(hourSource!, ...CRON_FIELDS[1]);
  const dayOfMonth = parseField(dayOfMonthSource!, ...CRON_FIELDS[2]);
  const month = parseField(monthSource!, ...CRON_FIELDS[3]);
  const dayOfWeek = parseField(dayOfWeekSource!, ...CRON_FIELDS[4]);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Return the first UTC cron occurrence strictly after an ISO-8601 UTC instant. */
export function nextCronOccurrence(expression: string, after: string): string | null {
  if (!isValidUtcTimestamp(after)) return null;
  const cron = parseCron(expression);
  if (!cron) return null;

  const candidate = new Date(Date.parse(after));
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Eight calendar years cover the longest practical gap (Feb 29). Advance by
  // calendar fields instead of checking every minute, so syntactically valid
  // but impossible expressions such as "0 0 31 2 *" reject cheaply.
  const finalYear = candidate.getUTCFullYear() + 8;
  while (candidate.getUTCFullYear() <= finalYear) {
    const month = nextValue(cron.month.values, candidate.getUTCMonth() + 1);
    if (month === null) {
      resetToMonth(candidate, candidate.getUTCFullYear() + 1, firstValue(cron.month.values));
      continue;
    }
    if (month !== candidate.getUTCMonth() + 1) {
      resetToMonth(candidate, candidate.getUTCFullYear(), month);
    }

    const day = nextMatchingDay(cron, candidate);
    if (day === null) {
      resetToMonth(candidate, candidate.getUTCFullYear(), candidate.getUTCMonth() + 2);
      continue;
    }
    if (day !== candidate.getUTCDate()) {
      candidate.setUTCDate(day);
      candidate.setUTCHours(0, 0, 0, 0);
    }

    const hour = nextValue(cron.hour.values, candidate.getUTCHours());
    if (hour === null) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (hour !== candidate.getUTCHours()) candidate.setUTCHours(hour, 0, 0, 0);

    const minute = nextValue(cron.minute.values, candidate.getUTCMinutes());
    if (minute === null) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    candidate.setUTCMinutes(minute, 0, 0);
    return candidate.toISOString();
  }
  return null;
}

function parseField(source: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  let any = false;
  for (const item of source.split(",")) {
    const stepParts = item.split("/");
    if (stepParts.length > 2 || stepParts.some((part) => part.length === 0)) return null;
    const [rangeSource, stepSource] = stepParts;
    const step = stepSource === undefined ? 1 : parseInteger(stepSource);
    if (step === null || step < 1) return null;

    let start: number;
    let end: number;
    if (rangeSource === "*") {
      any = true;
      start = min;
      end = max;
    } else {
      const range = rangeSource!.split("-");
      if (range.length > 2 || range.some((part) => part.length === 0)) return null;
      const rangeStart = parseInteger(range[0]!);
      const rangeEnd = range.length === 1 ? rangeStart : parseInteger(range[1]!);
      if (
        rangeStart === null ||
        rangeEnd === null ||
        rangeStart < min ||
        rangeEnd > max ||
        rangeStart > rangeEnd
      ) {
        return null;
      }
      if (stepSource !== undefined && range.length === 1) return null;
      start = rangeStart;
      end = rangeEnd;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { any, values };
}

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nextMatchingDay(cron: ParsedCron, date: Date): number | null {
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  for (let day = date.getUTCDate(); day <= lastDay; day += 1) {
    if (matchesDay(cron, day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day)))) {
      return day;
    }
  }
  return null;
}

function matchesDay(cron: ParsedCron, dayOfMonthValue: number, date: Date): boolean {
  const dayOfMonth = cron.dayOfMonth.values.has(dayOfMonthValue);
  const dayOfWeek = cron.dayOfWeek.values.has(date.getUTCDay());
  // Traditional five-field cron uses OR when both day fields are constrained.
  return cron.dayOfMonth.any && cron.dayOfWeek.any
    ? true
    : cron.dayOfMonth.any
      ? dayOfWeek
      : cron.dayOfWeek.any
        ? dayOfMonth
        : dayOfMonth || dayOfWeek;
}

function nextValue(values: Set<number>, value: number): number | null {
  for (let candidate = value; candidate <= 59; candidate += 1) {
    if (values.has(candidate)) return candidate;
  }
  return null;
}

function firstValue(values: Set<number>): number {
  return Math.min(...values);
}

function resetToMonth(date: Date, year: number, month: number): void {
  date.setUTCFullYear(year, month - 1, 1);
  date.setUTCHours(0, 0, 0, 0);
}
