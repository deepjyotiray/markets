(function () {
  const state = {
    range: '1m',
    payload: null,
    refreshTimer: null,
    refreshing: false,
  };

  function usd(value, digits = 2) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '$-';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(amount);
  }

  function pct(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '-';
    return (amount > 0 ? '+' : '') + amount.toFixed(2) + '%';
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
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
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

  function freshnessCopy(payload) {
    const updatedAt = payload?.updatedAt ? formatTimestamp(payload.updatedAt) : 'unknown time';
    const source = payload?.sourceMetadata?.holdingsSource === 'baseline-portfolio-snapshot'
      ? 'baseline snapshot fallback'
      : 'INDmoney MCP';
    return 'Updated ' + updatedAt + ' from ' + source;
  }

  function rangePayload() {
    return state.payload?.portfolioSeries?.[state.range] || null;
  }

  function renderSummary(payload) {
    const baseline = payload?.baseline || {};
    const currentValue = Number(baseline.latestValueUsd);
    const baselineValue = Number(baseline.baselineValueUsd);
    const change = Number(baseline.changeUsd);
    const changeNode = document.getElementById('changeUsd');
    text('currentValueUsd', Number.isFinite(currentValue) ? usd(currentValue) : '$-');
    text('baselineValueUsd', Number.isFinite(baselineValue) ? usd(baselineValue) : '$-');
    text('currentValueMeta', payload?.summary?.totalCurrentValueUsd ? 'INDmoney live holdings • ' + escapeHtml(payload.sessionMeta?.usSession || 'session') : 'Current INDMoney holdings');
    text('baselineMeta', 'June 5, 2026 close • current holdings repriced');
    if (changeNode) {
      changeNode.textContent = Number.isFinite(change) ? usd(change) : '$-';
      changeNode.className = signedClass(change);
    }
    text('changePct', pct(baseline.changePct));
    text('holdingsCount', String((payload?.holdings?.US_STOCK || []).length));
    text('freshnessCopy', freshnessCopy(payload));
  }

  function renderWarnings(payload) {
    const panel = document.getElementById('warningsPanel');
    const list = document.getElementById('warningsList');
    const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : [];
    if (!panel || !list) return;
    panel.hidden = warnings.length === 0;
    list.innerHTML = warnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join('');
  }

  function renderHoldings(payload) {
    const rows = Array.isArray(payload?.holdings?.US_STOCK) ? payload.holdings.US_STOCK : [];
    const body = document.getElementById('holdingsBody');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty-row">No US stock holdings returned.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      const changeClass = signedClass(row.change);
      return (
        '<tr>' +
          '<td data-label="Name"><strong>' + escapeHtml(row.name || row.ticker) + '</strong></td>' +
          '<td data-label="Ticker">' + escapeHtml(row.ticker || '-') + '</td>' +
          '<td class="num" data-label="Quantity">' + escapeHtml(String(row.quantity ?? '-')) + '</td>' +
          '<td class="num" data-label="Baseline Price">' + (row.baselinePrice == null ? '-' : usd(row.baselinePrice, 2)) + '</td>' +
          '<td class="num" data-label="Baseline Value">' + (row.baselineValue == null ? '-' : usd(row.baselineValue, 2)) + '</td>' +
          '<td class="num" data-label="Latest Price">' + (row.latestPrice == null ? '-' : usd(row.latestPrice, 2)) + '</td>' +
          '<td class="num" data-label="Latest Value">' + (row.latestValue == null ? '-' : usd(row.latestValue, 2)) + '</td>' +
          '<td class="num ' + changeClass + '" data-label="Change">' + (row.change == null ? '-' : usd(row.change, 2) + ' ' + pct(row.changePct)) + '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function linePath(points, width, height, padX, padY, minValue, maxValue) {
    return points.map((point, index) => {
      const x = padX + ((width - padX * 2) * index / Math.max(1, points.length - 1));
      const y = height - padY - ((point.value - minValue) / Math.max(1, maxValue - minValue)) * (height - padY * 2);
      return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }).join(' ');
  }

  function areaPath(points, width, height, padX, padY, minValue, maxValue) {
    if (!points.length) return '';
    const line = points.map((point, index) => {
      const x = padX + ((width - padX * 2) * index / Math.max(1, points.length - 1));
      const y = height - padY - ((point.value - minValue) / Math.max(1, maxValue - minValue)) * (height - padY * 2);
      return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }).join(' ');
    const lastX = padX + (width - padX * 2);
    const baseY = height - padY;
    return line + ' L ' + lastX.toFixed(2) + ' ' + baseY.toFixed(2) + ' L ' + padX.toFixed(2) + ' ' + baseY.toFixed(2) + ' Z';
  }

  function renderChart(payload) {
    const surface = document.getElementById('chartSurface');
    const currentRangePayload = rangePayload();
    if (!surface) return;
    const points = (currentRangePayload?.valuePoints || []).map((point) => ({
      time: point.time,
      value: Number(point.value),
    })).filter((point) => point.time && Number.isFinite(point.value));
    const baselineValue = Number(payload?.baseline?.baselineValueUsd);
    text('chartCopy', currentRangePayload
      ? 'Range ' + state.range.toUpperCase() + ' • baseline fixed at June 5, 2026 • ' + points.length + ' points'
      : 'Current holdings repriced through time.');
    if (!points.length) {
      surface.innerHTML = '<div class="chart-empty">No chart points available for this range yet.</div>';
      return;
    }
    const width = 1040;
    const height = 320;
    const padX = 34;
    const padY = 24;
    const values = points.map((point) => point.value);
    if (Number.isFinite(baselineValue)) values.push(baselineValue);
    const minValue = Math.min.apply(null, values);
    const maxValue = Math.max.apply(null, values);
    const baselineY = Number.isFinite(baselineValue)
      ? height - padY - ((baselineValue - minValue) / Math.max(1, maxValue - minValue)) * (height - padY * 2)
      : null;
    const lastPoint = points[points.length - 1];
    const firstPoint = points[0];
    surface.innerHTML =
      '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs>' +
          '<linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="rgba(13,107,87,0.32)"></stop>' +
            '<stop offset="100%" stop-color="rgba(13,107,87,0)"></stop>' +
          '</linearGradient>' +
        '</defs>' +
        '<line class="chart-grid" x1="' + padX + '" y1="' + (height - padY) + '" x2="' + (width - padX) + '" y2="' + (height - padY) + '"></line>' +
        (baselineY === null ? '' : '<line class="chart-baseline" x1="' + padX + '" y1="' + baselineY.toFixed(2) + '" x2="' + (width - padX) + '" y2="' + baselineY.toFixed(2) + '"></line>') +
        '<path class="chart-area" d="' + areaPath(points, width, height, padX, padY, minValue, maxValue) + '"></path>' +
        '<path class="chart-line" d="' + linePath(points, width, height, padX, padY, minValue, maxValue) + '"></path>' +
        '<text class="chart-label" x="' + padX + '" y="16">' + escapeHtml(firstPoint.time.slice(0, 10)) + '</text>' +
        '<text class="chart-label" x="' + (width - padX) + '" y="16" text-anchor="end">' + escapeHtml(lastPoint.time.slice(0, 10)) + '</text>' +
        (baselineY === null ? '' : '<text class="chart-label" x="' + (width - padX) + '" y="' + (baselineY - 8).toFixed(2) + '" text-anchor="end">Baseline ' + escapeHtml(usd(baselineValue, 0)) + '</text>') +
      '</svg>';
  }

  function render(payload) {
    state.payload = payload;
    renderSummary(payload);
    renderWarnings(payload);
    renderHoldings(payload);
    renderChart(payload);
  }

  function refreshIntervalMs(payload) {
    const interval = Number(payload?.sessionMeta?.usRefreshIntervalMs);
    return Number.isFinite(interval) && interval > 0 ? interval : 60000;
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    if (!state.payload) return;
    state.refreshTimer = window.setTimeout(() => {
      if (!document.hidden) {
        loadDashboard({ silent: true, auto: true });
      } else {
        scheduleRefresh();
      }
    }, refreshIntervalMs(state.payload));
  }

  async function loadDashboard(options) {
    if (state.refreshing) return;
    const config = options || {};
    state.refreshing = true;
    if (state.payload) {
      setStatus('Refreshing portfolio data…', 'refreshing');
    } else {
      setStatus('Loading portfolio data…');
    }
    try {
      const response = await fetch('/api/indmoney/dashboard?_ts=' + Date.now(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || 'Dashboard request failed');
      }
      render(payload);
      setStatus(
        config.auto
          ? 'Portfolio data refreshed.'
          : 'Portfolio data loaded.',
      );
      scheduleRefresh();
    } catch (error) {
      setStatus((state.payload ? 'Refresh failed: ' : 'Load failed: ') + (error.message || 'Unknown error'), 'error');
      scheduleRefresh();
    } finally {
      state.refreshing = false;
    }
  }

  document.querySelectorAll('#rangeSwitch [data-range]').forEach((button) => {
    button.addEventListener('click', function () {
      state.range = button.getAttribute('data-range') || '1m';
      document.querySelectorAll('#rangeSwitch [data-range]').forEach((item) => {
        item.classList.toggle('active', item === button);
      });
      if (state.payload) renderChart(state.payload);
    });
  });

  document.getElementById('refreshBtn')?.addEventListener('click', function () {
    loadDashboard({ silent: false, auto: false });
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.payload) {
      loadDashboard({ silent: true, auto: true });
    }
  });

  loadDashboard({ silent: false, auto: false });
})();
