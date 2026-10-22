export function estimateMissingDays(start: Date, end: Date, observedDates: Date[]): string[] {
  const observed = new Set(observedDates.map((date) => date.toISOString().slice(0, 10)));
  const missing: string[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setUTCHours(0, 0, 0, 0);
  while (cursor <= last && missing.length < 366) {
    const day = cursor.toISOString().slice(0, 10);
    if (!observed.has(day)) missing.push(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return missing;
}
