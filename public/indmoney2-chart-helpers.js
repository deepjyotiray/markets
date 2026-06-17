export const MARKET_TIME_ZONE = 'America/New_York';
export const MARKET_DAY_START_MINUTE = 4 * 60;
export const REGULAR_MARKET_START_MINUTE = 9 * 60 + 30;
export const REGULAR_MARKET_END_MINUTE = 16 * 60;
export const MARKET_DAY_END_MINUTE = 20 * 60;
export const INTRADAY_ZOOM_THRESHOLD_SECONDS = 2 * 86400;

const ET_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
});

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIME_ZONE,
  day: '2-digit',
  month: 'short',
});

function coerceDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'number') {
    return new Date(value < 100000000000 ? value * 1000 : value);
  }
  if (value && typeof value === 'object' && value.timestamp) {
    return new Date(Number(value.timestamp));
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value || ''))) {
    return new Date(String(value).replace(' ', 'T') + ':00-04:00');
  }
  return new Date(value);
}

export function etDateParts(value) {
  const date = coerceDate(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function etTimestampMs(year, month, day, hour = 0, minute = 0) {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute);
  const probeParts = etDateParts(approxUtc);
  if (!probeParts) return null;
  const actualUtc = approxUtc + (
    ((year - probeParts.year) * 525600)
    + ((month - probeParts.month) * 43200)
    + ((day - probeParts.day) * 1440)
    + ((hour - probeParts.hour) * 60)
    + (minute - probeParts.minute)
  ) * 60000;
  return actualUtc;
}

export function currentMarketDayEnvelope(value) {
  const parts = etDateParts(value);
  if (!parts) return null;
  return {
    startMs: etTimestampMs(parts.year, parts.month, parts.day, 4, 0),
    regularStartMs: etTimestampMs(parts.year, parts.month, parts.day, 9, 30),
    regularEndMs: etTimestampMs(parts.year, parts.month, parts.day, 16, 0),
    endMs: etTimestampMs(parts.year, parts.month, parts.day, 20, 0),
    dayKey: parts.dayKey,
    marketTimezone: MARKET_TIME_ZONE,
  };
}

export function currentMarketWeekEnvelope(value) {
  const parts = etDateParts(value);
  if (!parts) return null;
  const middayMs = etTimestampMs(parts.year, parts.month, parts.day, 12, 0);
  const weekday = new Date(middayMs).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const fridayOffset = mondayOffset + 4;
  const mondayMidday = new Date(middayMs + mondayOffset * 86400000);
  const fridayMidday = new Date(middayMs + fridayOffset * 86400000);
  const mondayParts = etDateParts(mondayMidday);
  const fridayParts = etDateParts(fridayMidday);
  return {
    startMs: etTimestampMs(mondayParts.year, mondayParts.month, mondayParts.day, 4, 0),
    endMs: etTimestampMs(fridayParts.year, fridayParts.month, fridayParts.day, 20, 0),
    marketTimezone: MARKET_TIME_ZONE,
  };
}

export function formatEtTimeLabel(value) {
  return ET_TIME_FORMATTER.format(coerceDate(value));
}

export function formatEtDateLabel(value) {
  return ET_DATE_FORMATTER.format(coerceDate(value));
}

export function isMajorDateTick(tickMarkType) {
  return tickMarkType === 0 || tickMarkType === 1 || tickMarkType === 2;
}

export function formatRangeAxisTick({ range, time, tickMarkType, spanSeconds = 0 }) {
  const zoomedIntoIntraday = spanSeconds > 0 && spanSeconds < INTRADAY_ZOOM_THRESHOLD_SECONDS;
  const zoomedIntoNearIntraday = spanSeconds > 0 && spanSeconds < 14 * 86400;
  if (range === '1d') {
    if (isMajorDateTick(tickMarkType)) return formatEtDateLabel(time);
    return formatEtTimeLabel(time);
  }
  if (range === '1w' || range === '1m' || range === 'all') {
    if (range === 'all' && zoomedIntoIntraday) {
      return `${formatEtDateLabel(time)} ${formatEtTimeLabel(time)}`;
    }
    if (range === 'all' && zoomedIntoNearIntraday) {
      return isMajorDateTick(tickMarkType)
        ? `${formatEtDateLabel(time)} ${formatEtTimeLabel(time)}`
        : formatEtTimeLabel(time);
    }
    if (!zoomedIntoIntraday) {
      return isMajorDateTick(tickMarkType) ? formatEtDateLabel(time) : '';
    }
    if (isMajorDateTick(tickMarkType)) return formatEtDateLabel(time);
    return formatEtTimeLabel(time);
  }
  return isMajorDateTick(tickMarkType) ? formatEtDateLabel(time) : formatEtTimeLabel(time);
}

export function shiftLogicalRangeToLatest(range, previousPointCount, nextPointCount, edgeTolerance = 2) {
  if (!range) return null;
  var previousTotal = Math.max(0, Number(previousPointCount) || 0);
  var nextTotal = Math.max(0, Number(nextPointCount) || 0);
  if (!previousTotal || !nextTotal || nextTotal <= previousTotal) return range;
  var from = Number(range.from);
  var to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return range;
  var previousLastIndex = previousTotal - 1;
  if (to < previousLastIndex - Math.max(0, Number(edgeTolerance) || 0)) {
    return range;
  }
  var delta = nextTotal - previousTotal;
  return {
    from: from + delta,
    to: to + delta,
  };
}
