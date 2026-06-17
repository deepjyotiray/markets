(function () {
  const config = window.__APP_SHELL__ || {};
  const defaultTabs = [
    ['/', 'Market', 'Cross-market dashboard'],
    ['/swing-trades', 'Swing', 'Trade scan'],
    ['/portfolio-alerts', 'Alerts', 'Risk decisions'],
    ['/watchlist-stocks', 'Watchlist', 'Buy list research'],
    ['/portfolio-earnings', 'Earnings', 'Post-print portfolio'],
    ['/portfolios', 'Combined', 'Merged portfolios'],
    ['/portfolios/deep', 'Deep', 'USD tracker'],
    ['/portfolios/mom', 'Mom', 'USD tracker'],
  ];
  const tabs = Array.isArray(config.tabs) && config.tabs.length ? config.tabs : defaultTabs;
  const currentPath = normalize(config.currentPath || window.location.pathname);
  const actionSelectors = Array.isArray(config.actionSelectors) ? config.actionSelectors : [];
  const pageMeta = new Map([
    ['/', ['Market Watch', 'Cross-market regime, macro, sectors, and watchlist', 'market']],
    ['/swing-trades', ['Swing Trades', 'Short-horizon trade research and timing', 'swing']],
    ['/portfolio-alerts', ['Alerts', 'Decision alerts and risk checks', 'alerts']],
    ['/watchlist-stocks', ['Watchlist', 'U.S. watchlist research', 'watchlist']],
    ['/portfolio-earnings', ['Portfolio Earnings', 'Post-print portfolio review', 'earnings']],
    ['/portfolios', ['Combined Portfolio', 'Deep and Mom merged together', 'portfolio']],
    ['/portfolios/deep', ['Deep Portfolio', 'Deep USD tracker', 'portfolio']],
    ['/portfolios/mom', ['Mom Portfolio', 'Mom USD tracker', 'portfolio']],
    ['/indmoney2', ['Deep Portfolio', 'Legacy path redirect', 'portfolio']],
  ]);
  const iconPaths = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sun: '<path d="M12 4V2M12 22v-2M4.93 4.93 3.52 3.52M20.48 20.48l-1.41-1.41M4 12H2M22 12h-2M4.93 19.07l-1.41 1.41M20.48 3.52l-1.41 1.41"/><circle cx="12" cy="12" r="4"/>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5Z"/>',
    auto: '<path d="M4 12a8 8 0 0 1 13.66-5.66"/><path d="M18 3v4h-4"/><path d="M20 12a8 8 0 0 1-13.66 5.66"/><path d="M6 21v-4h4"/>',
    market: '<path d="M4 19h16"/><path d="m6 15 4-5 4 3 5-8"/>',
    swing: '<path d="M4 17c4-8 8-8 16-2"/><path d="M4 7h16"/>',
    alerts: '<path d="M12 3 3 20h18L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
    watchlist: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="m4 6 .01 0M4 12h.01M4 18h.01"/>',
    earnings: '<path d="M5 6h14"/><path d="M5 11h14"/><path d="M5 16h8"/><path d="m15 14 2 2 4-5"/>',
    portfolio: '<path d="M4 18V6"/><path d="M9 18V9"/><path d="M14 18V4"/><path d="M19 18v-7"/><path d="M6 21h12"/>',
    indmoney2: '<path d="M4 18V6"/><path d="M9 18V9"/><path d="M14 18V4"/><path d="M19 18v-7"/><path d="M6 21h12"/>',
  };
  const navIcon = new Map([
    ['/', 'market'],
    ['/swing-trades', 'swing'],
    ['/portfolio-alerts', 'alerts'],
    ['/watchlist-stocks', 'watchlist'],
    ['/portfolio-earnings', 'earnings'],
    ['/portfolios', 'portfolio'],
    ['/portfolios/deep', 'portfolio'],
    ['/portfolios/mom', 'portfolio'],
    ['/indmoney2', 'portfolio'],
  ]);
  let truthSocialRefreshTimer = null;

  function normalize(path) {
    const clean = String(path || '/').replace(/\/+$/, '') || '/';
    return clean === '/alerts' ? '/portfolio-alerts' : clean;
  }

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${iconPaths[name] || ''}</svg>`;
  }

  function formatTimestamp(value) {
    if (!value) return 'not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'not available';
    return date.toLocaleString();
  }

  function formatOptionalTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function setDrawerTruthSocialRefresh(status) {
    const node = document.getElementById('appShellTruthSocialRefresh');
    if (!node) return;
    const lastScrape = formatTimestamp(status?.lastScrapeAt || status?.lastRunAt || null);
    const lastReload = formatOptionalTimestamp(status?.lastPageReloadAt || null);
    node.innerHTML = `
      <span><strong>Truth Social</strong></span>
      <span>Last scrape: ${lastScrape}</span>
      ${lastReload ? `<span>Last page reload: ${lastReload}</span>` : ''}
    `;
  }

  async function refreshTruthSocialStatus() {
    try {
      const response = await fetch('/api/truth-social-alerts/status', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Truth Social status request failed');
      }
      setDrawerTruthSocialRefresh(payload?.runtime || null);
    } catch {
      setDrawerTruthSocialRefresh(null);
    }
  }

  function startTruthSocialStatusLoop() {
    if (truthSocialRefreshTimer) return;
    refreshTruthSocialStatus();
    truthSocialRefreshTimer = window.setInterval(() => {
      if (!document.hidden) {
        refreshTruthSocialStatus();
      }
    }, 15000);
  }

  function getTheme() {
    return localStorage.getItem('market-app-theme') || 'auto';
  }

  function applyTheme(theme) {
    const next = theme === 'light' || theme === 'dark' ? theme : 'auto';
    if (next === 'light' || next === 'dark') {
      document.documentElement.dataset.appTheme = next;
      document.documentElement.dataset.theme = next;
    } else {
      document.documentElement.removeAttribute('data-app-theme');
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('market-app-theme', next);
    updateThemeButton(next);
    window.dispatchEvent(new CustomEvent('market-app-theme-change', { detail: { theme: next } }));
  }

  function cycleTheme() {
    const current = getTheme();
    applyTheme(current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto');
  }

  function updateThemeButton(theme) {
    const button = document.querySelector('[data-app-theme-toggle]');
    if (!button) return;
    const label = theme === 'auto' ? 'Theme: auto' : theme === 'dark' ? 'Theme: dark' : 'Theme: light';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.dataset.themeMode = theme;
    button.innerHTML = icon(theme === 'auto' ? 'auto' : theme === 'dark' ? 'moon' : 'sun');
  }

  function buildNavLinks() {
    return tabs.map((entry) => {
      const href = entry[0];
      const label = entry[1];
      const note = entry[2] || (defaultTabs.find((tab) => tab[0] === href) || [])[2] || '';
      const active = normalize(href) === currentPath;
      return `
        <a class="app-shell-nav-link" href="${href}"${active ? ' aria-current="page"' : ''}>
          ${icon(navIcon.get(normalize(href)) || 'market')}
          <span><strong>${label}</strong><small>${note}</small></span>
        </a>
      `;
    }).join('');
  }

  function buildShell() {
    if (document.querySelector('.app-shell-drawer')) return;
    const [title, subtitle, pageIcon] = pageMeta.get(currentPath) || pageMeta.get('/');
    const drawer = document.createElement('aside');
    drawer.className = 'app-shell-drawer';
    drawer.setAttribute('aria-label', 'Primary navigation');
    drawer.innerHTML = `
      <div class="app-shell-drawer-head">
        <a class="app-shell-brand" href="/" aria-label="Market dashboard home">
          <span class="app-shell-mark" aria-hidden="true"></span>
          <span class="app-shell-title"><strong>Markets</strong><small>Decision desk</small></span>
        </a>
        <button class="app-shell-icon-btn app-shell-drawer-close" type="button" data-app-close-drawer aria-label="Close navigation" title="Close navigation">
          ${icon('close')}
        </button>
      </div>
      <nav class="app-shell-nav" aria-label="Pages">${buildNavLinks()}</nav>
      <div class="app-shell-drawer-foot">
        <div class="app-shell-drawer-foot-meta">
          <span>Local dashboard</span>
          <strong>${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong>
        </div>
        <div id="appShellTruthSocialRefresh" class="app-shell-drawer-status">
          <span><strong>Truth Social</strong></span>
          <span>Last scrape: loading…</span>
        </div>
      </div>
    `;

    const bar = document.createElement('header');
    bar.className = 'app-shell-bar';
    bar.innerHTML = `
      <div class="app-shell-bar-main">
        <button class="app-shell-icon-btn app-shell-menu-btn" type="button" data-app-open-drawer aria-label="Open navigation" title="Open navigation">
          ${icon('menu')}
        </button>
        <div class="app-shell-page-title">
          <span class="app-shell-page-icon" aria-hidden="true">${icon(pageIcon || 'market')}</span>
          <span class="app-shell-page-copy"><strong>${title}</strong><span class="app-shell-page-subtitle">${subtitle}</span></span>
        </div>
      </div>
      <div class="app-shell-bar-actions">
        <button class="app-shell-icon-btn" id="themeToggle" type="button" data-app-theme-toggle aria-label="Theme" title="Theme"></button>
        <div class="app-shell-page-actions" aria-label="Page actions"></div>
      </div>
    `;

    const backdrop = document.createElement('button');
    backdrop.className = 'app-shell-backdrop';
    backdrop.type = 'button';
    backdrop.setAttribute('data-app-close-drawer', '');
    backdrop.setAttribute('aria-label', 'Close navigation');

    document.body.prepend(backdrop);
    document.body.prepend(bar);
    document.body.prepend(drawer);
    document.body.classList.add('app-shell-ready');
    movePageActions();
    observeTopbarSize();
    updateThemeButton(getTheme());
  }

  function movePageActions() {
    const slot = document.querySelector('.app-shell-page-actions');
    if (!slot || !actionSelectors.length) return;
    const directActionSelector = 'button, a, input, select, .toggle, .layout-tools, .toolbar-form';
    const containerSelector = '.actions, .toolbar, .hero-tools, .indmoney-toolbar';
    const sources = [];
    actionSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((source) => {
        if (!source.closest('.app-shell-bar') && !sources.includes(source)) {
          sources.push(source);
        }
      });
    });
    sources.forEach((source) => {
      const moveSourceDirectly = source.matches(directActionSelector) && !source.matches(containerSelector);
      if (moveSourceDirectly) {
        slot.appendChild(source);
        return;
      }
      Array.from(source.children).forEach((child) => {
        slot.appendChild(child);
      });
      if (!source.children.length) {
        source.classList.add('app-shell-actions-source-empty');
        source.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function syncTopbarSize() {
    const bar = document.querySelector('.app-shell-bar');
    if (!bar) return;
    const height = Math.ceil(bar.getBoundingClientRect().height);
    if (height > 0) {
      document.documentElement.style.setProperty('--app-topbar-h', `${height}px`);
    }
  }

  function observeTopbarSize() {
    const bar = document.querySelector('.app-shell-bar');
    if (!bar) return;
    syncTopbarSize();
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(syncTopbarSize);
      observer.observe(bar);
    }
    window.addEventListener('resize', syncTopbarSize);
  }

  function openDrawer() {
    document.body.classList.add('app-shell-drawer-open');
  }

  function closeDrawer() {
    document.body.classList.remove('app-shell-drawer-open');
  }

  function bindActions() {
    if (document.documentElement.dataset.appShellBound === 'true') return;
    document.documentElement.dataset.appShellBound = 'true';
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-app-open-drawer]')) {
        openDrawer();
      }
      if (event.target.closest('[data-app-close-drawer]')) {
        closeDrawer();
      }
      if (event.target.closest('[data-app-theme-toggle]')) {
        cycleTheme();
      }
      if (event.target.closest('.app-shell-nav-link')) {
        closeDrawer();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawer();
    });
    window.addEventListener('pageshow', closeDrawer);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshTruthSocialStatus();
      }
    });
  }

  applyTheme(getTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      buildShell();
      bindActions();
      startTruthSocialStatusLoop();
    });
  } else {
    buildShell();
    bindActions();
    startTruthSocialStatusLoop();
  }
})();
