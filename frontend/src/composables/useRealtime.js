export const normalizeRealtimeKey = value => String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();

export const nextRealtimeRetryDelay = current => Math.min(current * 2, 60_000);

export const realtimeStaleAfterMs = intervalMs => {
  const interval = Number(intervalMs);
  return Math.max(20_000, Number.isFinite(interval) && interval > 0 ? interval * 2 + 5_000 : 20_000);
};
