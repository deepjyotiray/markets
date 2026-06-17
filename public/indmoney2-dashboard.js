import {
  MARKET_TIME_ZONE,
  currentMarketDayEnvelope,
  currentMarketWeekEnvelope,
  etDateParts,
  formatEtDateLabel,
  formatEtTimeLabel,
  formatRangeAxisTick,
  shiftLogicalRangeToLatest,
} from '/indmoney2-chart-helpers.js';

(function () {
  const dashboardConfig = window.__INDMONEY2_DASHBOARD__ || {};
  const apiBasePath = dashboardConfig.apiBasePath || '/api/indmoney2';
  const authStartPath = dashboardConfig.authStartPath || '/api/indmoney/auth/start?returnTo=%2Fportfolios%2Fdeep';
  const state = {
    range: 'all',
    chartStyle: 'area',
    compareMode: 'off',
    indicators: {
      ma20: false,
      ma50: false,
    },
    activeChartMenu: null,
    sort: {
      key: 'ticker',
      direction: 'asc',
    },
    payload: null,
    refreshTimer: null,
    refreshing: false,
    eventSource: null,
    chartUi: null,
    chartLibraryPromise: null,
    chartViewByRange: {},
    chartPointCountByRange: {},
    chartPlotSourceByRange: {},
    chartResetRange: null,
    chartRenderedRange: null,
    applyingChartViewport: false,
    chartDecorationsFrame: 0,
  };

  function usd(value, digits) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '$-';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: digits == null ? 2 : digits,
      minimumFractionDigits: digits == null ? 2 : digits,
    }).format(amount);
  }

  function number(value, digits) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '-';
    return amount.toFixed(digits == null ? 2 : digits);
  }

  function pct(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '-';
    return (amount > 0 ? '+' : '') + amount.toFixed(2) + '%';
  }

  function rangeReturn(series) {
    var points = (series?.valuePoints || []).map(function (point) {
      return Number(point?.portfolioValueUsd ?? point?.value);
    }).filter(function (value) {
      return Number.isFinite(value);
    });
    if (points.length < 2) return null;
    var startValue = points[0];
    var endValue = points[points.length - 1];
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || startValue === 0) return null;
    var changeUsd = endValue - startValue;
    return {
      startValue: startValue,
      endValue: endValue,
      changeUsd: changeUsd,
      changePct: (changeUsd / Math.abs(startValue)) * 100,
    };
  }

  function signedClass(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '';
    return amount < 0 ? 'negative' : amount > 0 ? 'positive' : '';
  }

  function text(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function setStatus(message, tone) {
    const node = document.getElementById('status');
    if (!node) return;
    node.className = 'status-pill' + (tone ? ' is-' + tone : '');
    node.innerHTML = '<span class="dot"></span><span>' + escapeHtml(message) + '</span>';
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toLocaleString();
  }

  var CHART_TIME_ZONE = MARKET_TIME_ZONE;

  function chartDateFromValue(value) {
    if (value && typeof value === 'object' && value.timestamp) {
      return new Date(Number(value.timestamp));
    }
    if (typeof value === 'number') {
      return new Date(value < 100000000000 ? value * 1000 : value);
    }
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value || ''))) {
      return new Date(String(value).replace(' ', 'T') + ':00-04:00');
    }
    return new Date(value);
  }

  function formatChartDate(value, includeTime) {
    const date = chartDateFromValue(value);
    if (Number.isNaN(date.getTime())) return String(value || '-');
    return date.toLocaleString([], {
      timeZone: CHART_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  }

  function formatIstChartTime(time, options) {
    var date = chartDateFromValue(time);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: CHART_TIME_ZONE,
      month: 'short',
      day: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(options?.showSeconds ? { second: '2-digit' } : {}),
    }).format(date).replace(',', '');
  }

  function zonedDateParts(time, timeZone) {
    var date = chartDateFromValue(time);
    if (Number.isNaN(date.getTime())) return null;
    var parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || CHART_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date).map(function (part) {
      return [part.type, part.value];
    }));
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      dayKey: parts.year + '-' + parts.month + '-' + parts.day,
      minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }

  function axisGridCandidates() {
    return [5, 10, 15, 20, 30, 60, 120, 240, 480, 720, 1440];
  }

  function axisLabelMinGap(gridMinutes) {
    if (gridMinutes <= 20) return 64;
    if (gridMinutes <= 60) return 74;
    if (gridMinutes <= 240) return 84;
    if (gridMinutes <= 720) return 92;
    return 72;
  }

  function sameChartDay(leftTime, rightTime) {
    var left = zonedDateParts(leftTime);
    var right = zonedDateParts(rightTime);
    return Boolean(left && right && left.dayKey === right.dayKey);
  }

  function formatIstTimeLabel(time) {
    return formatEtTimeLabel(time);
  }

  function formatIstDateLabel(time) {
    return formatEtDateLabel(time);
  }

  function formatPortfolioAxisLabel(time, previousTickTime, gridMinutes, options) {
    var date = chartDateFromValue(time);
    if (Number.isNaN(date.getTime())) return '';
    var marketOpenMajor = Boolean(options?.marketOpenMajor);
    if (gridMinutes >= 1440) {
      return formatIstDateLabel(time);
    }
    if (marketOpenMajor) {
      if (!previousTickTime || !sameChartDay(previousTickTime, time)) {
        return formatIstDateLabel(time) + ' 19:00';
      }
      return '19:00';
    }
    if (!previousTickTime || !sameChartDay(previousTickTime, time)) {
      return formatIstDateLabel(time) + ' ' + formatIstTimeLabel(time);
    }
    return formatIstTimeLabel(time);
  }

  function marketOpenMajorTimesByDay(points) {
    var targets = new Map();
    points.forEach(function (point) {
      var parts = zonedDateParts(point.time);
      if (!parts) return;
      if (parts.minuteOfDay < 19 * 60) return;
      if (!targets.has(parts.dayKey)) {
        targets.set(parts.dayKey, Number(point.time));
      }
    });
    return targets;
  }

  function calendarTickSteps(visibleDays) {
    if (visibleDays > 180) return [30, 14, 7];
    if (visibleDays > 90) return [14, 7, 3];
    if (visibleDays > 30) return [7, 3, 2];
    return [3, 2, 1];
  }

  function buildPortfolioAxisTicks(visiblePoints, chart, width, gridMinutes) {
    var ticks = [];
    var previousTickTime = null;
    var dayAnchorByKey = new Map();
    var marketOpenByDay = marketOpenMajorTimesByDay(visiblePoints);
    visiblePoints.forEach(function (point, index) {
      var parts = zonedDateParts(point.time);
      if (!parts) return;
      var previousPointParts = index > 0 ? zonedDateParts(visiblePoints[index - 1].time) : null;
      var dayStart = !previousPointParts || previousPointParts.dayKey !== parts.dayKey;
      if (!dayAnchorByKey.has(parts.dayKey)) {
        dayAnchorByKey.set(parts.dayKey, parts.minuteOfDay);
      }
      var anchorMinute = dayAnchorByKey.get(parts.dayKey);
      var marketOpenMajor = marketOpenByDay.get(parts.dayKey) === Number(point.time);
      var matchesGrid = gridMinutes >= 1440
        ? dayStart
        : ((parts.minuteOfDay - anchorMinute + 1440) % gridMinutes === 0);
      if (!matchesGrid && !dayStart && !marketOpenMajor) return;
      var x = chart.timeScale().timeToCoordinate(point.time);
      if (!Number.isFinite(x) || x < 0 || x > width) return;
      ticks.push({
        x: x,
        time: point.time,
        dayStart: dayStart,
        marketOpenMajor: marketOpenMajor,
        label: formatPortfolioAxisLabel(point.time, previousTickTime, gridMinutes, { marketOpenMajor: marketOpenMajor }),
      });
      previousTickTime = point.time;
    });
    return ticks;
  }

  function filterAxisTicksByGap(ticks, minGap) {
    var kept = [];
    var lastX = -Infinity;
    ticks.forEach(function (tick) {
      var forceKeep = tick.dayStart || tick.marketOpenMajor;
      if (forceKeep || tick.x - lastX >= minGap) {
        kept.push(tick);
        lastX = tick.x;
      } else if (forceKeep && kept.length) {
        kept[kept.length - 1] = tick;
        lastX = tick.x;
      }
    });
    return kept;
  }

  function choosePortfolioAxisTicks(visiblePoints, chart, width) {
    if (!visiblePoints.length || !width) return [];
    var firstTime = Number(visiblePoints[0]?.time);
    var lastTime = Number(visiblePoints[visiblePoints.length - 1]?.time);
    var visibleDays = Math.max(1, (lastTime - firstTime) / 86400);
    var candidates = axisGridCandidates();
    for (var index = 0; index < candidates.length; index += 1) {
      var gridMinutes = candidates[index];
      var ticks = buildPortfolioAxisTicks(visiblePoints, chart, width, gridMinutes);
      if (!ticks.length) continue;
      var minGap = axisLabelMinGap(gridMinutes);
      var filtered = filterAxisTicksByGap(ticks, minGap);
      if (filtered.length >= 2 && filtered.length <= Math.max(2, Math.floor(width / minGap) + 1)) {
        return filtered;
      }
      if (gridMinutes >= 1440) {
        break;
      }
    }
    var visibleByDay = visiblePoints.filter(function (point, index) {
      return index === 0 || !sameChartDay(visiblePoints[index - 1].time, point.time);
    });
    var steps = calendarTickSteps(visibleDays);
    for (var stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      var step = steps[stepIndex];
      var ticks = visibleByDay.map(function (point, index) {
        if (index !== 0 && index !== visibleByDay.length - 1 && index % step !== 0) return null;
        var x = chart.timeScale().timeToCoordinate(point.time);
        if (!Number.isFinite(x) || x < 0 || x > width) return null;
        return {
          x: x,
          time: point.time,
          dayStart: true,
          label: formatIstDateLabel(point.time),
        };
      }).filter(Boolean);
      var filtered = filterAxisTicksByGap(ticks, 72);
      if (filtered.length >= 2 || step === steps[steps.length - 1]) {
        return filtered;
      }
    }
    return [];
  }

  function formatRangeLabel(range) {
    return range === 'all' ? 'MAX' : String(range || '').toUpperCase();
  }

  function rangeWindowLabel(range) {
    var currentOnly = state.payload?.historyMode === 'current_only';
    return range === '1d'
      ? 'Today'
      : range === '1w'
        ? 'This week'
        : range === '1m'
          ? (currentOnly ? 'This account' : 'This month')
          : (currentOnly ? 'Since inception' : 'Since Jun 5');
  }

  function rangeTitle(range) {
    return range === 'all' ? 'Full chart' : formatRangeLabel(range) + ' chart';
  }

  function compactUsd(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '$-';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(amount);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function renderWarnings(payload) {
    const panel = document.getElementById('warningsPanel');
    const list = document.getElementById('warningsList');
    const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : [];
    if (!panel || !list) return;
    panel.hidden = warnings.length === 0;
    list.innerHTML = warnings.map(function (warning) {
      return '<li>' + escapeHtml(warning) + '</li>';
    }).join('');
  }

  function setAuthPanel(visible, message) {
    var panel = document.getElementById('authPanel');
    var node = document.getElementById('authMessage');
    if (!panel) return;
    panel.hidden = !visible;
    if (node && message) {
      node.textContent = message;
    }
  }

  function normalizeConnectLinks() {
    var expectedHref = authStartPath;
    document.querySelectorAll('a[href*="/api/indmoney/auth/start"]').forEach(function (link) {
      link.setAttribute('href', expectedHref);
    });
  }

  function renderSummary(payload) {
    const summary = payload?.summary || {};
    text('currentPortfolioValueUsd', usd(summary.currentPortfolioValueUsd));
    text('oneDayPnlUsd', usd(summary.oneDayPnlUsd));
    text('oneDayPnlPct', pct(summary.oneDayPnlPct));
    text('actualPnlUsd', usd(summary.actualPnlUsd));
    text('actualPnlPct', pct(summary.actualPnlPct));

    var oneDayNode = document.getElementById('oneDayPnlUsd');
    var actualNode = document.getElementById('actualPnlUsd');
    if (oneDayNode) oneDayNode.className = signedClass(summary.oneDayPnlUsd);
    if (actualNode) actualNode.className = signedClass(summary.actualPnlUsd);

    text('currentPortfolioMeta', 'Updated ' + formatTimestamp(payload?.updatedAt) + ' • session ' + (payload?.sessionMeta?.marketSession || 'unknown'));
    text('chartRangeTitle', rangeTitle(state.range));
    renderMetricSplit(payload);
  }

  function metricSplitText(components, fieldUsd, fieldPct) {
    if (!Array.isArray(components) || components.length < 2) return '';
    return components.map(function (item) {
      return (item.label || item.key || 'Portfolio') + ' ' + usd(item?.summary?.[fieldUsd]) + ' (' + pct(item?.summary?.[fieldPct]) + ')';
    }).join(' + ');
  }

  function renderMetricSplit(payload) {
    var oneDayNode = document.getElementById('oneDayPnlSplit');
    var actualNode = document.getElementById('actualPnlSplit');
    var isCombined = String(dashboardConfig.portfolioKey || '') === 'combined';
    var components = Array.isArray(payload?.componentPortfolios) ? payload.componentPortfolios.filter(Boolean) : [];
    if (!oneDayNode || !actualNode) return;
    if (!isCombined || components.length < 2) {
      oneDayNode.hidden = true;
      actualNode.hidden = true;
      oneDayNode.textContent = '';
      actualNode.textContent = '';
      return;
    }
    oneDayNode.textContent = metricSplitText(components, 'oneDayPnlUsd', 'oneDayPnlPct');
    actualNode.textContent = metricSplitText(components, 'actualPnlUsd', 'actualPnlPct');
    oneDayNode.hidden = false;
    actualNode.hidden = false;
  }

  function renderAccountSplit(payload) {
    var panel = document.getElementById('accountSplitPanel');
    var grid = document.getElementById('accountSplitGrid');
    var components = Array.isArray(payload?.componentPortfolios) ? payload.componentPortfolios.filter(Boolean) : [];
    var isCombined = String(dashboardConfig.portfolioKey || '') === 'combined';
    if (!panel || !grid) return;
    if (!isCombined || components.length < 2) {
      panel.hidden = true;
      grid.innerHTML = '';
      return;
    }
    var total = payload?.summary || {};
    var cards = [{
      label: 'Total',
      href: '/portfolios',
      summary: {
        currentPortfolioValueUsd: total.currentPortfolioValueUsd,
        actualPnlUsd: total.actualPnlUsd,
        actualPnlPct: total.actualPnlPct,
      },
      meta: 'Deep + Mom',
      total: true,
    }].concat(components.map(function (item) {
      return {
        label: item.label || item.key || 'Portfolio',
        href: item.routePath || '/portfolios/' + encodeURIComponent(String(item.key || '').toLowerCase()),
        summary: item.summary || {},
        meta: 'Open account',
        total: false,
      };
    }));
    grid.innerHTML = cards.map(function (card) {
      var pnl = Number(card.summary?.actualPnlUsd);
      var tone = signedClass(pnl);
      return (
        '<a class="account-split-card' + (card.total ? ' is-total' : '') + '" href="' + escapeHtml(card.href) + '">' +
          '<span class="account-split-label">' + escapeHtml(card.label) + '</span>' +
          '<strong class="account-split-value">' + usd(card.summary?.currentPortfolioValueUsd) + '</strong>' +
          '<span class="account-split-meta ' + tone + '">' + usd(card.summary?.actualPnlUsd) + ' • ' + pct(card.summary?.actualPnlPct) + '</span>' +
          '<span class="account-split-foot subtle">' + escapeHtml(card.meta) + '</span>' +
        '</a>'
      );
    }).join('');
    panel.hidden = false;
  }

  function renderFx(payload) {
    const fx = payload?.fx || {};
    text('effectiveFxRate', Number.isFinite(Number(fx.effectiveUsdInrRate)) ? number(fx.effectiveUsdInrRate, 4) : '-');
    text('totalInvestedInrFromMcp', Number.isFinite(Number(fx.totalInvestedInrFromMcp)) ? Number(fx.totalInvestedInrFromMcp).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-');
    text('manualActualInvestedUsdValue', usd(fx.manualActualInvestedUsd));
    text('fxUpdatedAt', fx.updatedAt ? 'Config updated ' + formatTimestamp(fx.updatedAt) : 'Manual USD invested amount is not configured yet.');
    var input = document.getElementById('manualActualInvestedUsdInput');
    if (input && fx.manualActualInvestedUsd != null && document.activeElement !== input) {
      input.value = Number(fx.manualActualInvestedUsd).toFixed(2);
    }
  }

  function renderHoldings(payload) {
    const rows = Array.isArray(payload?.holdings) ? payload.holdings : [];
    const body = document.getElementById('holdingsBody');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="14" class="empty-row">No US stock holdings returned.</td></tr>';
      syncHoldingsSortUi();
      return;
    }
    var sortedRows = sortHoldings(rows);
    body.innerHTML = sortedRows.map(function (row) {
      return (
        '<tr>' +
          '<td data-label="Ticker"><strong>' + escapeHtml(row.ticker || '-') + '</strong></td>' +
          '<td data-label="Name">' + escapeHtml(row.name || '-') + '</td>' +
          '<td class="num" data-label="Quantity">' + escapeHtml(number(row.quantity, 4)) + '</td>' +
          '<td class="num" data-label="Invested USD">' + usd(row.investedUsd) + '</td>' +
          '<td class="num" data-label="Avg Price">' + usd(row.avgPriceUsd, 4) + '</td>' +
          '<td class="num" data-label="Current Price">' + usd(row.currentPriceUsd, 4) + '</td>' +
          '<td class="num" data-label="Market Value">' + usd(row.currentHoldingValueUsd) + '</td>' +
          '<td class="num ' + signedClass(row.oneDayPnlUsd) + '" data-label="1D PNL USD">' + usd(row.oneDayPnlUsd) + '</td>' +
          '<td class="num ' + signedClass(row.oneDayPnlPct) + '" data-label="1D %">' + pct(row.oneDayPnlPct) + '</td>' +
          '<td class="num ' + signedClass(row.actualPnlUsd) + '" data-label="Actual PNL USD">' + usd(row.actualPnlUsd) + '</td>' +
          '<td class="num ' + signedClass(row.actualPnlPct) + '" data-label="Actual %">' + pct(row.actualPnlPct) + '</td>' +
          '<td data-label="Session">' + escapeHtml(row.priceSession || '-') + '</td>' +
          '<td data-label="Updated">' + escapeHtml(formatTimestamp(row.updatedAt)) + '</td>' +
          '<td data-label="Source">' + escapeHtml(row.priceSource || '-') + '</td>' +
        '</tr>'
      );
    }).join('');
    syncHoldingsSortUi();
  }

  function compareStrings(left, right) {
    return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
  }

  function compareNumbers(left, right) {
    var leftValue = Number(left);
    var rightValue = Number(right);
    var leftValid = Number.isFinite(leftValue);
    var rightValid = Number.isFinite(rightValue);
    if (!leftValid && !rightValid) return 0;
    if (!leftValid) return 1;
    if (!rightValid) return -1;
    return leftValue - rightValue;
  }

  function compareDates(left, right) {
    var leftValue = new Date(left).getTime();
    var rightValue = new Date(right).getTime();
    var leftValid = Number.isFinite(leftValue);
    var rightValid = Number.isFinite(rightValue);
    if (!leftValid && !rightValid) return 0;
    if (!leftValid) return 1;
    if (!rightValid) return -1;
    return leftValue - rightValue;
  }

  function compareHoldings(left, right, key) {
    switch (key) {
      case 'ticker':
      case 'name':
      case 'priceSession':
      case 'priceSource':
        return compareStrings(left[key], right[key]);
      case 'updatedAt':
        return compareDates(left[key], right[key]);
      default:
        return compareNumbers(left[key], right[key]);
    }
  }

  function sortHoldings(rows) {
    var direction = state.sort.direction === 'desc' ? -1 : 1;
    var key = state.sort.key || 'ticker';
    return rows.slice().sort(function (left, right) {
      var comparison = compareHoldings(left, right, key);
      if (comparison !== 0) return comparison * direction;
      return compareStrings(left.ticker, right.ticker);
    });
  }

  function syncHoldingsSortUi() {
    document.querySelectorAll('[data-sort-key]').forEach(function (button) {
      var key = button.getAttribute('data-sort-key') || '';
      var active = key === state.sort.key;
      var indicator = button.querySelector('.sort-indicator');
      var th = button.closest('th');
      button.classList.toggle('active', active);
      if (indicator) {
        indicator.textContent = active ? (state.sort.direction === 'desc' ? '↓' : '↑') : '↕';
      }
      if (th) {
        th.setAttribute('aria-sort', active ? (state.sort.direction === 'desc' ? 'descending' : 'ascending') : 'none');
      }
    });
  }

  function currentSeries() {
    return state.payload?.series?.[state.range] || null;
  }

  function chartSeriesForRange(rangeKey) {
    if (!state.payload?.series) return { series: null, sourceRange: null };
    var range = rangeKey || state.range;
    // ponytail: open each range on its own viewport, but plot from the continuous source so pan never dead-ends early.
    var useContinuousSource = range !== 'all' && state.payload.series.all;
    var series = useContinuousSource
      ? state.payload.series.all
      : (state.payload.series[range] || state.payload.series.all || null);
    return {
      series: series,
      sourceRange: useContinuousSource ? 'all' : (state.payload.series[range] ? range : (state.payload.series.all ? 'all' : null)),
    };
  }

  function movingAveragePoints(points, windowSize) {
    if (!Array.isArray(points) || points.length < windowSize) return [];
    var total = 0;
    var results = [];
    for (var index = 0; index < points.length; index += 1) {
      total += Number(points[index]?.value || 0);
      if (index >= windowSize) {
        total -= Number(points[index - windowSize]?.value || 0);
      }
      if (index >= windowSize - 1) {
        results.push({
          time: points[index].time,
          value: total / windowSize,
        });
      }
    }
    return results;
  }

  function compareSeriesPoints(points, payload) {
    if (!Array.isArray(points) || !points.length) return [];
    var baseline = Number(payload?.fx?.manualActualInvestedUsd);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      baseline = Number(points[0]?.value);
    }
    if (!Number.isFinite(baseline) || baseline <= 0) return [];
    return points.map(function (point) {
      return {
        time: point.time,
        value: baseline,
      };
    });
  }

  function updatePrimaryMetric(payload) {
    var summary = payload?.summary || {};
    var changeUsd = Number(summary.actualPnlUsd);
    var changePct = Number(summary.actualPnlPct);
    text('chartPrimaryChangeUsd', usd(changeUsd));
    text('chartPrimaryChangePct', pct(changePct));
    text('chartPrimaryChangeLabel', 'Total return');
    var node = document.querySelector('.chart-quote-change');
    if (node) {
      node.className = 'chart-quote-change';
      var tone = signedClass(changeUsd);
      if (tone) {
        node.classList.add(tone);
      } else {
        node.classList.add('neutral');
      }
    }
  }

  function syncChartToolbarUi() {
    var styleBtn = document.getElementById('chartStyleBtn');
    var compareBtn = document.getElementById('chartCompareBtn');
    var indicatorsBtn = document.getElementById('chartIndicatorsBtn');
    if (styleBtn) {
      styleBtn.textContent = state.chartStyle === 'line' ? 'Line' : 'Area';
      styleBtn.classList.toggle('active', state.activeChartMenu === 'style');
    }
    if (compareBtn) {
      compareBtn.classList.toggle('active', state.activeChartMenu === 'compare' || state.compareMode !== 'off');
      compareBtn.textContent = state.compareMode === 'invested' ? 'Invested' : 'Compare';
    }
    if (indicatorsBtn) {
      var enabledCount = Number(Boolean(state.indicators.ma20)) + Number(Boolean(state.indicators.ma50));
      indicatorsBtn.classList.toggle('active', state.activeChartMenu === 'indicators' || enabledCount > 0);
      indicatorsBtn.textContent = enabledCount ? ('Indicators (' + enabledCount + ')') : 'Indicators';
    }
    document.querySelectorAll('[data-chart-style]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-chart-style') === state.chartStyle);
    });
    document.querySelectorAll('[data-compare-mode]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-compare-mode') === state.compareMode);
    });
    document.querySelectorAll('[data-indicator]').forEach(function (button) {
      var key = button.getAttribute('data-indicator') || '';
      var active = Boolean(state.indicators[key]);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    var menus = {
      style: document.getElementById('chartStyleMenu'),
      compare: document.getElementById('chartCompareMenu'),
      indicators: document.getElementById('chartIndicatorsMenu'),
    };
    Object.keys(menus).forEach(function (key) {
      var menu = menus[key];
      if (!menu) return;
      menu.hidden = state.activeChartMenu !== key;
    });
  }

  function tradingDayKey(value) {
    return String(value || '').slice(0, 10);
  }

  function chartDayKey(value) {
    const date = chartDateFromValue(value);
    if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 10);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CHART_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return [map.year, map.month, map.day].filter(Boolean).join('-');
  }

  function chartCanvasDimensions(canvas) {
    var bounds = canvas?.getBoundingClientRect?.();
    var width = Math.max(260, Math.round(bounds?.width || canvas?.clientWidth || 320));
    var height = Math.max(260, Math.round(bounds?.height || canvas?.clientHeight || width));
    return { width: width, height: height };
  }

  function portfolioPointTime(point) {
    var timestamp = Number(point?.timestamp);
    if (Number.isFinite(timestamp)) {
      return Math.floor(timestamp / 1000);
    }
    var date = chartDateFromValue(point?.time);
    return Number.isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
  }

  function updateChartHover(point) {
    var ui = state.chartUi;
    if (!ui) return;
    var tooltip = ui.surface.querySelector('[data-chart-tooltip]');
    if (!tooltip) return;

    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.value)) {
      tooltip.hidden = true;
      return;
    }

    tooltip.hidden = true;
  }

  function chartBarSpacing(range, pointCount) {
    if (range === '1d') return 18;
    if (range === '1w') return 12;
    if (range === '1m') return 9;
    var total = Number(pointCount) || 0;
    if (total > 20000) return 0.12;
    if (total > 8000) return 0.25;
    if (total > 3000) return 0.5;
    if (total > 1000) return 0.8;
    return 1.4;
  }

  function visibleTimeSpanSeconds() {
    var ui = state.chartUi;
    var points = ui?.valuePoints || [];
    var chart = ui?.chart;
    if (!chart || points.length < 2) return 0;
    var range = chart.timeScale().getVisibleLogicalRange?.();
    var fromIndex = clamp(Math.floor(Number(range?.from ?? 0)), 0, points.length - 1);
    var toIndex = clamp(Math.ceil(Number(range?.to ?? (points.length - 1))), fromIndex, points.length - 1);
    var fromTime = Number(points[fromIndex]?.time);
    var toTime = Number(points[toIndex]?.time);
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) return 0;
    return toTime - fromTime;
  }

  function visibleTimeBounds() {
    var ui = state.chartUi;
    var points = ui?.valuePoints || [];
    var chart = ui?.chart;
    if (!chart || points.length < 1) return null;
    var range = chart.timeScale().getVisibleLogicalRange?.();
    var fromIndex = clamp(Math.floor(Number(range?.from ?? 0)), 0, points.length - 1);
    var toIndex = clamp(Math.ceil(Number(range?.to ?? (points.length - 1))), fromIndex, points.length - 1);
    var fromTime = Number(points[fromIndex]?.time);
    var toTime = Number(points[toIndex]?.time);
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) return null;
    return { fromTime: fromTime, toTime: toTime };
  }

  function zoomContextLabel() {
    var spanSeconds = visibleTimeSpanSeconds();
    if (!spanSeconds) return 'Date view';
    if (spanSeconds < 2 * 86400) return 'Intraday time view';
    if (spanSeconds < 14 * 86400) return 'Day and time view';
    return 'Date view';
  }

  function visibleWindowLabel() {
    var bounds = visibleTimeBounds();
    if (!bounds) return 'Full history since Jun 5';
    if (bounds.toTime - bounds.fromTime < 2 * 86400) {
      return formatChartDate(bounds.fromTime, true) + ' to ' + formatChartDate(bounds.toTime, true);
    }
    return formatChartDate(bounds.fromTime, false) + ' to ' + formatChartDate(bounds.toTime, false);
  }

  function updateZoomContext() {
    text('chartRangeNote', visibleWindowLabel() + ' • ' + zoomContextLabel());
  }

  function formatChartAxisTick(time, tickMarkType) {
    return formatRangeAxisTick({
      range: state.chartRenderedRange || state.range,
      time: time,
      tickMarkType: tickMarkType,
      spanSeconds: visibleTimeSpanSeconds(),
    });
  }

  function normalizedLogicalRange(range, pointCount) {
    if (!range || !Number.isFinite(pointCount) || pointCount <= 0) return null;
    var minIndex = 0;
    var maxIndex = Math.max(0, pointCount - 1);
    var from = Number(range.from);
    var to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (to < from) {
      var swap = from;
      from = to;
      to = swap;
    }
    var width = Math.max(0, to - from);
    from = clamp(from, minIndex, maxIndex);
    to = clamp(to, from, maxIndex);
    if (to - from < width) {
      from = clamp(to - width, minIndex, maxIndex);
    }
    return { from: from, to: to };
  }

  function defaultLogicalRangeForWindow(pointCount, windowPointCount) {
    var total = Math.max(0, Number(pointCount) || 0);
    if (!total) return null;
    var windowSize = Math.max(2, Math.min(total, Number(windowPointCount) || total));
    return {
      from: Math.max(0, total - windowSize),
      to: Math.max(0, total - 1),
    };
  }

  function saveCurrentLogicalRange(rangeKey, chart, pointCount) {
    var normalized = normalizedLogicalRange(chart?.timeScale?.().getVisibleLogicalRange?.(), pointCount);
    if (!normalized) return;
    state.chartViewByRange[rangeKey] = normalized;
  }

  function logicalRangeForTimes(valuePoints, startTime, endTime) {
    if (!Array.isArray(valuePoints) || !valuePoints.length) return null;
    var start = Number(startTime);
    var end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end < start) {
      var swap = start;
      start = end;
      end = swap;
    }
    var fromIndex = valuePoints.findIndex(function (point) {
      return Number(point?.time) >= start;
    });
    if (fromIndex < 0) fromIndex = 0;
    var toIndex = -1;
    for (var index = valuePoints.length - 1; index >= 0; index -= 1) {
      if (Number(valuePoints[index]?.time) <= end) {
        toIndex = index;
        break;
      }
    }
    if (toIndex < 0) toIndex = valuePoints.length - 1;
    if (toIndex < fromIndex) {
      toIndex = Math.min(valuePoints.length - 1, fromIndex + 1);
    }
    return {
      from: Math.max(0, fromIndex - 1),
      to: Math.min(valuePoints.length - 1, toIndex + 1),
      timeBased: false,
    };
  }

  function defaultViewportForRange(rangeKey, fallbackRange, seriesOverride, valuePointsOverride) {
    var series = seriesOverride || state.payload?.series?.[rangeKey];
    var plottedPoints = Array.isArray(valuePointsOverride) ? valuePointsOverride : [];
    var viewportStart = Number(series?.viewportStart);
    var viewportEnd = Number(series?.viewportEnd);
    if (Number.isFinite(viewportStart) && Number.isFinite(viewportEnd) && viewportEnd > viewportStart) {
      var logicalViewport = logicalRangeForTimes(plottedPoints, viewportStart / 1000, viewportEnd / 1000);
      if (logicalViewport) {
        return logicalViewport;
      }
      return {
        from: viewportStart / 1000,
        to: viewportEnd / 1000,
        timeBased: true,
      };
    }
    var valuePoints = Array.isArray(series?.valuePoints) ? series.valuePoints : [];
    var firstPointTime = portfolioPointTime(valuePoints[0]);
    var lastPointTime = portfolioPointTime(valuePoints.at(-1));
    if (Number.isFinite(firstPointTime) && Number.isFinite(lastPointTime) && lastPointTime > firstPointTime) {
      var logicalPointRange = logicalRangeForTimes(plottedPoints, firstPointTime, lastPointTime);
      if (logicalPointRange) {
        return logicalPointRange;
      }
      return {
        from: firstPointTime,
        to: lastPointTime,
        timeBased: true,
      };
    }
    return fallbackRange ? { from: fallbackRange.from, to: fallbackRange.to, timeBased: false } : null;
  }

  function sessionOverlaySegments() {
    if (window.innerWidth <= 640) return [];
    var bounds = visibleTimeBounds();
    if (!bounds) return [];
    if (bounds.toTime - bounds.fromTime > 3 * 86400) return [];
    var startMs = bounds.fromTime * 1000;
    var endMs = bounds.toTime * 1000;
    var visiblePoints = (state.chartUi?.valuePoints || []).filter(function (point) {
      var time = Number(point?.time);
      return Number.isFinite(time) && time >= bounds.fromTime && time <= bounds.toTime;
    });
    var seenDays = new Set();
    var segments = [];
    visiblePoints.forEach(function (point) {
      var envelope = currentMarketDayEnvelope(Number(point.time) * 1000);
      if (!envelope || seenDays.has(envelope.dayKey)) return;
      seenDays.add(envelope.dayKey);
      [
        {
          key: envelope.dayKey + '-pre',
          label: 'Pre',
          start: envelope.startMs,
          end: envelope.regularStartMs,
          tone: 'pre',
          boundaryClass: 'is-day-start',
          labelClass: 'is-pre',
        },
        {
          key: envelope.dayKey + '-market',
          label: 'Market',
          start: envelope.regularStartMs,
          end: envelope.regularEndMs,
          tone: 'market',
          boundaryClass: 'is-regular-boundary',
          labelClass: 'is-market',
        },
        {
          key: envelope.dayKey + '-post',
          label: 'Post',
          start: envelope.regularEndMs,
          end: envelope.endMs,
          tone: 'post',
          boundaryClass: 'is-regular-boundary',
          labelClass: 'is-post',
        },
      ].forEach(function (segment) {
        var clippedStart = Math.max(startMs, segment.start);
        var clippedEnd = Math.min(endMs, segment.end);
        if (clippedEnd <= clippedStart) return;
        segments.push({
          key: segment.key,
          label: segment.label,
          start: clippedStart / 1000,
          end: clippedEnd / 1000,
          tone: segment.tone,
          boundaryClass: segment.boundaryClass,
          labelClass: segment.labelClass,
        });
      });
    });
    return segments;
  }

  function updateSessionOverlay() {
    var ui = state.chartUi;
    var overlay = ui?.sessionOverlay;
    var chart = ui?.chart;
    if (!overlay || !chart) return;
    var segments = sessionOverlaySegments();
    if (!segments.length) {
      overlay.innerHTML = '';
      overlay.hidden = true;
      return;
    }
    var html = [];
    segments.forEach(function (segment) {
      var startX = chart.timeScale().timeToCoordinate(segment.start);
      var endX = chart.timeScale().timeToCoordinate(segment.end);
      if (!Number.isFinite(startX) || !Number.isFinite(endX)) return;
      var left = Math.max(0, Math.min(startX, endX));
      var width = Math.max(0, Math.abs(endX - startX));
      html.push('<div class="chart-session-band is-' + segment.tone + '" style="left:' + left.toFixed(1) + 'px;width:' + width.toFixed(1) + 'px"><span class="' + escapeHtml(segment.labelClass || '') + '">' + escapeHtml(segment.label) + '</span></div>');
      html.push('<div class="chart-session-line ' + escapeHtml(segment.boundaryClass || 'is-boundary') + '" style="left:' + left.toFixed(1) + 'px"></div>');
    });
    var lastSegment = segments[segments.length - 1];
    var finalX = chart.timeScale().timeToCoordinate(lastSegment.end);
    if (Number.isFinite(finalX)) {
      html.push('<div class="chart-session-line is-boundary" style="left:' + Math.max(0, finalX).toFixed(1) + 'px"></div>');
    }
    overlay.hidden = false;
    overlay.innerHTML = html.join('');
  }

  function scheduleChartDecorationsUpdate() {
    if (state.chartDecorationsFrame) return;
    state.chartDecorationsFrame = window.requestAnimationFrame(function () {
      state.chartDecorationsFrame = 0;
      updateSessionOverlay();
    });
  }

  function applyLogicalRange(rangeKey, chart, pointCount, fallbackRange) {
    var visibleRange = normalizedLogicalRange(state.chartViewByRange[rangeKey], pointCount)
      || null;
    if (visibleRange) {
      state.applyingChartViewport = true;
      try {
        chart.timeScale().setVisibleLogicalRange(visibleRange);
      } finally {
        state.applyingChartViewport = false;
      }
      state.chartViewByRange[rangeKey] = visibleRange;
      return;
    }
    if (fallbackRange?.timeBased) {
      state.applyingChartViewport = true;
      try {
        chart.timeScale().setVisibleRange({ from: fallbackRange.from, to: fallbackRange.to });
      } finally {
        state.applyingChartViewport = false;
      }
      window.requestAnimationFrame(function () {
        saveCurrentLogicalRange(rangeKey, chart, pointCount);
        scheduleChartDecorationsUpdate();
      });
      return;
    }
    if (fallbackRange && Number.isFinite(fallbackRange.from) && Number.isFinite(fallbackRange.to)) {
      state.applyingChartViewport = true;
      try {
        chart.timeScale().setVisibleLogicalRange(fallbackRange);
      } finally {
        state.applyingChartViewport = false;
      }
      state.chartViewByRange[rangeKey] = fallbackRange;
      return;
    }
    chart.timeScale().fitContent();
    window.requestAnimationFrame(function () {
      saveCurrentLogicalRange(rangeKey, chart, pointCount);
    });
  }

  function loadLightweightCharts() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (state.chartLibraryPromise) return state.chartLibraryPromise;
    state.chartLibraryPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';
      script.onload = function () { resolve(window.LightweightCharts); };
      script.onerror = function () { reject(new Error('Lightweight Charts failed to load')); };
      document.head.appendChild(script);
    });
    return state.chartLibraryPromise;
  }

  async function initPortfolioChart() {
    if (state.chartUi?.chart) return state.chartUi;
    var L = await loadLightweightCharts();
    var surface = document.getElementById('chartSurface');
    if (!surface) return null;
    surface.innerHTML =
      '<div class="chart-stage">' +
        '<div class="chart-session-overlay" data-chart-session-overlay hidden></div>' +
        '<div class="chart-tooltip" data-chart-tooltip hidden></div>' +
        '<div class="chart-canvas" data-chart-canvas></div>' +
      '</div>';
    var canvas = surface.querySelector('[data-chart-canvas]');
    var sessionOverlay = surface.querySelector('[data-chart-session-overlay]');
    var chartSize = chartCanvasDimensions(canvas);
    var chart = L.createChart(canvas, {
      width: chartSize.width,
      height: chartSize.height,
      layout: {
        background: { color: 'transparent' },
        textColor: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#67727a',
        fontSize: 12,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(24, 33, 38, 0.07)' },
      },
      rightPriceScale: {
        visible: true,
        autoScale: true,
        borderVisible: false,
        ticksVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.12 },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        minBarSpacing: 0.05,
        rightOffset: 6,
        tickMarkFormatter: function (time, tickMarkType) {
          return formatChartAxisTick(time, tickMarkType);
        },
      },
      crosshair: {
        mode: L.CrosshairMode.Normal,
        vertLine: { color: 'rgba(24, 33, 38, 0.12)', width: 1, style: 0, labelVisible: true },
        horzLine: { color: 'rgba(24, 33, 38, 0.12)', width: 1, style: 2, visible: false, labelVisible: true },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      localization: {
        locale: 'en-US',
        timeFormatter: function (time) {
          return formatIstChartTime(time);
        },
      },
    });
    var series = chart.addAreaSeries({
      lineColor: 'rgba(24, 128, 56, 1)',
      topColor: 'rgba(24, 128, 56, 0.16)',
      bottomColor: 'rgba(24, 128, 56, 0.01)',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBackgroundColor: 'rgba(24, 128, 56, 1)',
      crosshairMarkerBorderColor: '#fff',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });
    var lineSeries = chart.addLineSeries({
      color: 'rgba(24, 128, 56, 1)',
      lineWidth: 2.4,
      priceLineVisible: true,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });
    var compareSeries = chart.addLineSeries({
      color: 'rgba(95, 99, 104, 0.7)',
      lineWidth: 1.6,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    var ma20Series = chart.addLineSeries({
      color: 'rgba(26, 115, 232, 0.92)',
      lineWidth: 1.7,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    var ma50Series = chart.addLineSeries({
      color: 'rgba(176, 96, 0, 0.9)',
      lineWidth: 1.7,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.subscribeCrosshairMove(function (param) {
      if (!param || !param.point || !param.time) {
        updateChartHover(null);
        return;
      }
      var price = param.seriesData.get(series) || param.seriesData.get(lineSeries);
      if (price == null) {
        updateChartHover(null);
        return;
      }
      updateChartHover({
        x: param.point.x,
        value: Number(price.value ?? price.close ?? price),
        originalTime: '',
      });
    });
    window.addEventListener('resize', function () {
      if (!state.chartUi?.chart || !state.chartUi.canvas) return;
      var nextSize = chartCanvasDimensions(state.chartUi.canvas);
      state.chartUi.chart.applyOptions({
        width: nextSize.width,
        height: nextSize.height,
      });
      scheduleChartDecorationsUpdate();
    });
    state.chartUi = {
      surface: surface,
      canvas: canvas,
      sessionOverlay: sessionOverlay,
      chart: chart,
      series: series,
      lineSeries: lineSeries,
      compareSeries: compareSeries,
      ma20Series: ma20Series,
      ma50Series: ma50Series,
      includeTime: false,
      valuePoints: [],
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      if (state.applyingChartViewport) return;
      var rangeKey = state.chartRenderedRange || state.range;
      var normalized = normalizedLogicalRange(range, state.chartPointCountByRange[rangeKey] || 0);
      if (!normalized) return;
      state.chartViewByRange[rangeKey] = normalized;
      updateZoomContext();
      scheduleChartDecorationsUpdate();
    });
    return state.chartUi;
  }

  function renderChart(payload) {
    var renderRange = state.range;
    const selectedSeries = currentSeries();
    const plotConfig = chartSeriesForRange(renderRange);
    const plotSeries = plotConfig.series;
    const plotSourceRange = plotConfig.sourceRange;
    const points = (plotSeries?.valuePoints || []).map(function (point) {
      return {
        time: point.time,
        timestamp: point.timestamp,
        portfolioValueUsd: Number(point.portfolioValueUsd),
      };
    }).filter(function (point) {
      return point.time && Number.isFinite(point.portfolioValueUsd);
    });
    var includeTime = plotSeries?.granularity === 'minute' || plotSeries?.granularity === 'hourly' || plotSeries?.granularity === 'mixed';
    var copySeries = selectedSeries || plotSeries;
    updatePrimaryMetric(payload);
    text('chartRangeTitle', rangeTitle(renderRange));
    text('chartCopy', copySeries
      ? (
          renderRange === '1d'
            ? '1D chart • latest trading day'
            : renderRange === '1w'
              ? '1W chart • current market week'
              : renderRange === '1m'
                ? (
                    payload?.historyMode === 'current_only'
                      ? '1M chart • current account history only'
                      : '1M chart • hourly snapshots since Jun 5 investment baseline'
                  )
                : (
                    payload?.historyMode === 'current_only'
                      ? 'Full chart • current account history only'
                      : 'Full chart • entire portfolio history since Jun 5'
                  )
        ) + ' • ' + (
          copySeries?.granularity === 'point-in-time'
            ? 'no repricing'
            : copySeries?.granularity === 'hourly'
            ? 'hourly repricing'
            : copySeries?.granularity === 'mixed'
              ? 'compressed repricing'
              : includeTime
                ? 'intraday repricing'
                : 'daily repricing'
        )
      : (payload?.historyMode === 'current_only' ? 'Current account history only.' : 'Current holdings repriced through time.'));
    var surface = document.getElementById('chartSurface');
    if (!surface) return;
    if (!points.length) {
      state.chartPointCountByRange[renderRange] = 0;
      surface.innerHTML = '<div class="chart-empty">No chart points available for this range yet.</div>';
      if (state.chartUi?.series) {
        state.chartUi.series.setData([]);
        state.chartUi.lineSeries?.setData([]);
        state.chartUi.compareSeries?.setData([]);
        state.chartUi.ma20Series?.setData([]);
        state.chartUi.ma50Series?.setData([]);
      }
      return;
    }
    initPortfolioChart().then(function (ui) {
      if (!ui) return;
      var previousPointCount = state.chartPointCountByRange[renderRange] || 0;
      var shouldResetViewport = state.chartResetRange === renderRange
        || state.chartPlotSourceByRange[renderRange] !== plotSourceRange;
      if (shouldResetViewport) {
        delete state.chartViewByRange[renderRange];
      }
      state.chartPlotSourceByRange[renderRange] = plotSourceRange;
      ui.includeTime = includeTime;
      var valuePoints = points.map(function (point, index) {
        var time = portfolioPointTime(point);
        if (!time) return null;
        return {
          time: time,
          value: point.portfolioValueUsd,
        };
      }).filter(Boolean);
      var colorPoints = (selectedSeries?.valuePoints || plotSeries?.valuePoints || []).filter(function (point) {
        return Number.isFinite(Number(point?.portfolioValueUsd));
      });
      var firstColorValue = Number(colorPoints[0]?.portfolioValueUsd ?? points[0]?.portfolioValueUsd);
      var lastColorValue = Number(colorPoints.at(-1)?.portfolioValueUsd ?? points.at(-1)?.portfolioValueUsd);
      var rising = lastColorValue >= firstColorValue;
      var lineColor = rising ? 'rgba(19, 115, 51, 1)' : 'rgba(197, 34, 31, 1)';
      var topColor = rising ? 'rgba(19, 115, 51, 0.14)' : 'rgba(197, 34, 31, 0.12)';
      ui.valuePoints = valuePoints;
      ui.series.applyOptions({
        lineColor: lineColor,
        topColor: topColor,
        bottomColor: 'rgba(255,255,255,0.01)',
        priceLineColor: lineColor,
        lastValueVisible: state.chartStyle === 'area',
        priceLineVisible: state.chartStyle === 'area',
      });
      ui.lineSeries.applyOptions({
        color: lineColor,
        priceLineColor: lineColor,
        lastValueVisible: state.chartStyle === 'line',
        priceLineVisible: state.chartStyle === 'line',
      });
      ui.chart.timeScale().applyOptions({
        barSpacing: chartBarSpacing(renderRange, valuePoints.length),
        minBarSpacing: 0.05,
        rightOffset: 6,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: function (time, tickMarkType) {
          return formatChartAxisTick(time, tickMarkType);
        },
      });
      state.chartPointCountByRange[renderRange] = valuePoints.length;
      if (!shouldResetViewport && state.chartViewByRange[renderRange]) {
        state.chartViewByRange[renderRange] = shiftLogicalRangeToLatest(
          state.chartViewByRange[renderRange],
          previousPointCount,
          valuePoints.length,
        ) || state.chartViewByRange[renderRange];
      }
      state.applyingChartViewport = true;
      try {
        ui.series.setData(state.chartStyle === 'area' ? valuePoints : []);
        ui.lineSeries.setData(state.chartStyle === 'line' ? valuePoints : []);
        ui.compareSeries.setData(state.compareMode === 'invested' ? compareSeriesPoints(valuePoints, payload) : []);
        ui.ma20Series.setData(state.indicators.ma20 ? movingAveragePoints(valuePoints, 20) : []);
        ui.ma50Series.setData(state.indicators.ma50 ? movingAveragePoints(valuePoints, 50) : []);
      } finally {
        state.applyingChartViewport = false;
      }
      if (shouldResetViewport) {
        delete state.chartViewByRange[renderRange];
        if (state.chartResetRange === renderRange) {
          state.chartResetRange = null;
        }
      }
      state.chartRenderedRange = renderRange;
      var fallbackViewport = defaultViewportForRange(renderRange, null, selectedSeries || plotSeries, valuePoints);
      applyLogicalRange(renderRange, ui.chart, valuePoints.length, fallbackViewport);
      updateZoomContext();
      updateChartHover(null);
      scheduleChartDecorationsUpdate();
    }).catch(function (error) {
      surface.innerHTML = '<div class="chart-empty">' + escapeHtml(error.message || 'Chart failed to load.') + '</div>';
    });
  }

  function render(payload) {
    state.payload = payload;
    setAuthPanel(false);
    renderSummary(payload);
    renderAccountSplit(payload);
    renderFx(payload);
    renderWarnings(payload);
    renderHoldings(payload);
    renderChart(payload);
  }

  function refreshIntervalMs() {
    return 20000;
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(function () {
      if (!document.hidden) {
        loadDashboard({ silent: true, auto: true });
      } else {
        scheduleRefresh();
      }
    }, refreshIntervalMs());
  }

  async function loadDashboard(options) {
    if (state.refreshing) return;
    var config = options || {};
    state.refreshing = true;
    setStatus(state.payload ? 'Refreshing portfolio data…' : 'Loading portfolio data…', state.payload ? 'refreshing' : '');
    try {
      var response = await fetch(apiBasePath + '/dashboard?_ts=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(payload.error || 'Dashboard request failed');
      }
      render(payload);
      setStatus(config.auto ? 'Portfolio data refreshed.' : 'Portfolio data loaded.');
      scheduleRefresh();
    } catch (error) {
      var message = error.message || 'Unknown error';
      var authLikeFailure =
        /login required|reconnect your account|mcp login required/i.test(message);
      if (authLikeFailure) {
        setAuthPanel(true, 'Click Connect INDmoney, complete auth, then return here and refresh.');
      }
      setStatus((state.payload ? 'Refresh failed: ' : 'Load failed: ') + message, 'error');
      scheduleRefresh();
    } finally {
      state.refreshing = false;
    }
  }

  async function saveFxConfig(event) {
    event.preventDefault();
    var input = document.getElementById('manualActualInvestedUsdInput');
    var value = input ? Number(input.value) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      setStatus('Enter a positive manual USD invested amount before saving.', 'error');
      return;
    }
    setStatus('Saving FX config…', 'refreshing');
    try {
      var response = await fetch(apiBasePath + '/fx-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ manualActualInvestedUsd: value }),
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(payload.error || 'FX config save failed');
      }
      setStatus('FX config saved. Recomputing dashboard…');
      await loadDashboard({ silent: true });
    } catch (error) {
      setStatus('FX config save failed: ' + (error.message || 'Unknown error'), 'error');
    }
  }

  function initEventStream() {
    if (!('EventSource' in window)) return;
    try {
      var source = new EventSource(apiBasePath + '/stream');
      source.addEventListener('dashboard', function (event) {
        var payload = JSON.parse(event.data || '{}');
        if (!state.payload || !payload.summary) return;
        state.payload.summary = payload.summary;
        state.payload.holdings = payload.holdings || state.payload.holdings;
        state.payload.series = payload.series || state.payload.series;
        state.payload.warnings = payload.warnings || state.payload.warnings;
        state.payload.updatedAt = payload.updatedAt || state.payload.updatedAt;
        render(state.payload);
        setStatus('Live snapshot updated.');
      });
      source.addEventListener('error', function () {
        source.close();
      });
      state.eventSource = source;
    } catch (error) {
      console.error('SSE init failed', error);
    }
  }

  document.querySelectorAll('[data-chart-menu]').forEach(function (button) {
    button.addEventListener('click', function () {
      var menu = button.getAttribute('data-chart-menu') || '';
      state.activeChartMenu = state.activeChartMenu === menu ? null : menu;
      syncChartToolbarUi();
    });
  });

  document.querySelectorAll('[data-chart-style]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.chartStyle = button.getAttribute('data-chart-style') || 'area';
      state.activeChartMenu = null;
      syncChartToolbarUi();
      if (state.payload) renderChart(state.payload);
    });
  });

  document.querySelectorAll('[data-compare-mode]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.compareMode = button.getAttribute('data-compare-mode') || 'off';
      state.activeChartMenu = null;
      syncChartToolbarUi();
      if (state.payload) renderChart(state.payload);
    });
  });

  document.querySelectorAll('[data-indicator]').forEach(function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-indicator') || '';
      if (!key) return;
      state.indicators[key] = !state.indicators[key];
      syncChartToolbarUi();
      if (state.payload) renderChart(state.payload);
    });
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('#chartToolbarGroup') && !event.target.closest('#chartToolbarPopovers')) {
      if (state.activeChartMenu) {
        state.activeChartMenu = null;
        syncChartToolbarUi();
      }
    }
  });

  document.getElementById('chartResetViewBtn')?.addEventListener('click', function () {
    var ui = state.chartUi;
    if (!ui?.chart) return;
    state.activeChartMenu = null;
    syncChartToolbarUi();
    delete state.chartViewByRange[state.range];
    state.applyingChartViewport = true;
    try {
      ui.chart.timeScale().fitContent();
    } finally {
      state.applyingChartViewport = false;
    }
    window.requestAnimationFrame(function () {
      saveCurrentLogicalRange(state.range, ui.chart, state.chartPointCountByRange[state.range] || 0);
      updateZoomContext();
      scheduleChartDecorationsUpdate();
    });
  });

  document.querySelectorAll('[data-sort-key]').forEach(function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-sort-key') || 'ticker';
      if (state.sort.key === key) {
        state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.direction = key === 'updatedAt' ? 'desc' : 'asc';
      }
      if (state.payload) renderHoldings(state.payload);
    });
  });

  document.getElementById('refreshBtn')?.addEventListener('click', function () {
    loadDashboard({});
  });

  document.getElementById('fxForm')?.addEventListener('submit', saveFxConfig);

  document.getElementById('fxToggleBtn')?.addEventListener('click', function () {
    var body = document.getElementById('fxPanelBody');
    var isHidden = body.hasAttribute('hidden');
    if (isHidden) {
      body.removeAttribute('hidden');
      this.textContent = 'Hide';
      this.setAttribute('aria-expanded', 'true');
    } else {
      body.setAttribute('hidden', '');
      this.textContent = 'Show';
      this.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      loadDashboard({ silent: true, auto: true });
    }
  });

  normalizeConnectLinks();
  syncChartToolbarUi();
  updateZoomContext();
  loadDashboard({});
  syncHoldingsSortUi();
  initEventStream();
})();
