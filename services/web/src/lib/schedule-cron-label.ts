export function routeLabel(
  target?: { providerId?: string; commandId?: string } | null,
): string | null {
  if (!target) return null;
  if (target.providerId) return `provider:${target.providerId}`;
  if (target.commandId) return `command:${target.commandId}`;
  return null;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const CUSTOM_SCHEDULE = "Custom schedule";

/** Describe common five-field UTC cron expressions without hiding the raw expression. */
export function describeCron(expression: string): string {
  if (expression === "* * * * *") return "Every minute";

  const interval = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(expression);
  if (interval) {
    const minutes = Number(interval[1]);
    if (minutes > 59 || 60 % minutes !== 0) return CUSTOM_SCHEDULE;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }

  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(expression);
  if (hourly) {
    const minute = Number(hourly[1]);
    if (minute > 59) return CUSTOM_SCHEDULE;
    return minute === 0 ? "Every hour" : `Every hour at minute ${minute}`;
  }

  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);
  if (daily) return describeAtTime(daily[1]!, daily[2]!, "Every day");

  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* (\d)$/.exec(expression);
  if (weekly) {
    const weekday = Number(weekly[3]);
    if (weekday > 6) return CUSTOM_SCHEDULE;
    return describeAtTime(weekly[1]!, weekly[2]!, `Every ${WEEKDAYS[weekday]}`);
  }

  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(expression);
  if (monthly) {
    const day = Number(monthly[3]);
    if (day < 1 || day > 31) return CUSTOM_SCHEDULE;
    return describeAtTime(monthly[1]!, monthly[2]!, `Every month on day ${day}`);
  }

  return CUSTOM_SCHEDULE;
}

function describeAtTime(minuteSource: string, hourSource: string, prefix: string): string {
  const minute = Number(minuteSource);
  const hour = Number(hourSource);
  if (minute > 59 || hour > 23) return CUSTOM_SCHEDULE;
  const hour12 = hour % 12 || 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${prefix} at ${hour12}:${String(minute).padStart(2, "0")} ${meridiem} UTC`;
}
