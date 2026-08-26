export function timestampMs(value) {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.valueOf() : NaN;
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
  }
  return Date.parse(value || '');
}

export function timestampDate(value) {
  const milliseconds = timestampMs(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}
