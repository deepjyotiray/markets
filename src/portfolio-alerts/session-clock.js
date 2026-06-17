import { getTimePartsInZone, zoneDateKey } from './utils.js';

export function getSessionClock(now, marketTimezone = 'America/New_York') {
  const parts = getTimePartsInZone(now, marketTimezone);
  const totalMinutes = parts.hour * 60 + parts.minute;
  const openMinutes = 9 * 60 + 30;
  const regularCloseMinutes = 16 * 60;
  const preMarketMinutes = 4 * 60;
  const postMarketCloseMinutes = 20 * 60;
  const minutesFromOpen = totalMinutes - openMinutes;

  let bucket = 'CLOSED';
  if (totalMinutes >= preMarketMinutes && totalMinutes < openMinutes) {
    bucket = 'PRE_MARKET';
  } else if (totalMinutes >= openMinutes && totalMinutes < openMinutes + 15) {
    bucket = 'OPENING_RANGE';
  } else if (totalMinutes >= openMinutes + 15 && totalMinutes < regularCloseMinutes - 60) {
    bucket = 'REGULAR_MARKET';
  } else if (totalMinutes >= regularCloseMinutes - 60 && totalMinutes < regularCloseMinutes) {
    bucket = 'POWER_HOUR';
  } else if (totalMinutes >= regularCloseMinutes && totalMinutes < postMarketCloseMinutes) {
    bucket = 'POST_MARKET';
  }

  return {
    bucket,
    minutesFromOpen,
    isPreMarket: bucket === 'PRE_MARKET',
    isRegular: ['OPENING_RANGE', 'REGULAR_MARKET', 'POWER_HOUR'].includes(bucket),
    isPostMarket: bucket === 'POST_MARKET',
    isClosed: bucket === 'CLOSED',
    allowWatchThink: minutesFromOpen >= 15 || bucket === 'PRE_MARKET' || bucket === 'POST_MARKET' || bucket === 'POWER_HOUR',
    allowActionAlerts: minutesFromOpen >= 30 || bucket === 'PRE_MARKET' || bucket === 'POST_MARKET' || bucket === 'POWER_HOUR',
    protectionBias: bucket === 'POWER_HOUR',
    marketDayKey: zoneDateKey(now, marketTimezone),
  };
}

