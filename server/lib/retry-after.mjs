export const retryAtFromHeader = (value, now = Date.now()) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  const timestamp = Number.isFinite(seconds)
    ? seconds >= 0 ? now + seconds * 1000 : NaN
    : Date.parse(value);
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
