(function () {
  'use strict';
  if (typeof location === 'undefined' || location.protocol !== 'https:' || location.hostname !== '127.0.0.1') {
    return;
  }

  const CAPSULE_VERSION = 13;
  const LOCAL_CLOCK_INTERVAL_MS = 30_000;
  const SPEED_COOL_DELAY_MS = 15_000;
  const HOST_INLINE_STYLE =
    'display: inline-flex; align-items: center; flex-shrink: 0; margin-left: 6px; margin-right: 6px; position: relative; vertical-align: middle;';
  const CORE = globalThis.__AGY_CAPSULE_CORE__;
  if (!CORE) return;

  try {
    globalThis.__agyCapsule?.dispose?.();
  } catch {}

  const {
    I18N,
    normalizeLocale,
    detectLocaleFromCandidates,
    classifySpeed,
    formatResetDateTime,
    formatResetShort,
    fmtK,
    fmtColK,
    fmtPreciseK,
    matchModelQuotaGroup,
  } = CORE;

  const LANG_CYCLE = ['en', 'zh-CN', 'zh-TW'];

  const state = {
    ownerTs: Number(globalThis.__AGY_CAPSULE_INIT_TS || 0) || Date.now(),
    disposed: false,
    convId: '',
    prefs: { langMode: 'auto', themeMode: 'auto' },
    quotaGroups: [],
    latest: null,
    scan: null,
    scanBusy: false,
    scanError: '',
    isTurnInFlight: false,
    wasTurnInFlight: false,
    speedCoolUntilMs: 0,
    matchedGroup: null,
    openPop: null, // null | 'ctx' | 'quota'
    pinnedPop: null, // null | 'ctx' | 'quota'
    pendingForceScan: false,
    pendingPrefsPatch: null,
    hostLangCache: 'en',
  };

  function getRouteConvId() {
    const m = (location.pathname || '').match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1] : '';
  }

  function detectHostLocale() {
    const candidates = [];
    try {
      if (document?.documentElement?.lang) candidates.push(document.documentElement.lang);
      if (document?.body?.lang) candidates.push(document.body.lang);
      if (typeof navigator !== 'undefined') {
        if (navigator.language) candidates.push(navigator.language);
        if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      }
      if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
        candidates.push(Intl.DateTimeFormat().resolvedOptions()?.locale);
      }
    } catch {}
    return detectLocaleFromCandidates(candidates, 'en');
  }

  function resolveLanguage() {
    const mode = state.prefs?.langMode || 'auto';
    if (mode !== 'auto') return normalizeLocale(mode, 'en');
    state.hostLangCache = detectHostLocale();
    return state.hostLangCache;
  }

  function getDict() {
    const lang = resolveLanguage();
    return I18N[lang] || I18N.en;
  }

  function parseLuminance(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const s = colorStr.trim();
    const hexMatch = s.replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hexMatch)) {
      const full = hexMatch.length === 3 ? hexMatch.split('').map((c) => c + c).join('') : hexMatch;
      const num = parseInt(full, 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    const rgbMatch = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
      return (0.299 * Number(rgbMatch[1]) + 0.587 * Number(rgbMatch[2]) + 0.114 * Number(rgbMatch[3])) / 255;
    }
    return null;
  }

  function detectHostTheme() {
    try {
      const body = document.body;
      const doc = document.documentElement;
      if (
        body?.classList?.contains('theme-light') ||
        body?.classList?.contains('light') ||
        doc?.classList?.contains('light') ||
        body?.classList?.contains('vscode-light')
      ) {
        return 'light';
      }
      if (
        body?.classList?.contains('theme-dark') ||
        body?.classList?.contains('dark') ||
        doc?.classList?.contains('dark') ||
        body?.classList?.contains('vscode-dark')
      ) {
        return 'dark';
      }
      if (doc?.style?.colorScheme === 'light') return 'light';
      if (doc?.style?.colorScheme === 'dark') return 'dark';
      if (typeof getComputedStyle === 'function' && (body || doc)) {
        const cs = getComputedStyle(body || doc);
        const lum = parseLuminance(cs.getPropertyValue('--background') || cs.backgroundColor);
        if (lum != null) return lum > 0.55 ? 'light' : 'dark';
      }
      if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) {
        return 'light';
      }
    } catch {}
    return 'dark';
  }

  function resolveTheme() {
    const mode = state.prefs?.themeMode || 'auto';
    if (mode === 'light' || mode === 'dark') return mode;
    return detectHostTheme();
  }

  // Create Shadow DOM host
  const host = document.createElement('div');
  host.id = 'agy-capsule-host';
  host.setAttribute('data-capsule-ver', String(CAPSULE_VERSION));
  host.style.cssText = HOST_INLINE_STYLE;
  const shadow = host.attachShadow({ mode: 'open' });

  const STYLES = `
    :host {
      --agc-font: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      --agc-fg: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
      --agc-fg-strong: var(--foreground, #f4f4f6);
      --agc-muted: var(--muted-foreground, #8e8e93);
      --agc-pill-hover: var(--secondary, rgba(128, 128, 128, 0.14));
      --agc-pop-bg: var(--card, rgba(20, 20, 22, 0.97));
      --agc-pop-border: var(--border, rgba(128, 128, 128, 0.20));
      --agc-track: rgba(142, 142, 147, 0.24);
      --agc-divider: rgba(142, 142, 147, 0.18);
      --agc-good: #4ea84e;
      --agc-warn: #d4940a;
      --agc-danger: #e06c75;
      --agc-danger-bg: rgba(224, 108, 117, 0.10);
      --agc-warn-bg: rgba(212, 148, 10, 0.10);
      --agc-neutral-bg: rgba(142, 142, 147, 0.11);
      --agc-speed: #38bdf8;
      --agc-c-sys: #818cf8;
      --agc-c-tool: #388bfd;
      --agc-c-ast: #00b386;
      --agc-c-thk: #b37feb;
      --agc-c-usr: #d4940a;
      --agc-c-sum: #2dd4bf;
      --agc-c-att: #e86a24;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      margin: 0 6px;
      position: relative;
      font-family: var(--agc-font);
      font-size: 12.5px;
      font-weight: 400;
      line-height: normal;
      color: var(--agc-muted);
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    :host([data-theme="light"]) {
      --agc-fg: color-mix(in srgb, var(--foreground, #18181b) 88%, transparent);
      --agc-fg-strong: var(--foreground, #18181b);
      --agc-muted: var(--muted-foreground, #71717a);
      --agc-pill-hover: var(--secondary, rgba(128, 128, 128, 0.12));
      --agc-pop-bg: var(--card, rgba(255, 255, 255, 0.98));
      --agc-pop-border: var(--border, rgba(128, 128, 128, 0.18));
      --agc-track: rgba(142, 142, 147, 0.22);
      --agc-divider: rgba(142, 142, 147, 0.18);
      --agc-good: #16a34a;
      --agc-warn: #d97706;
      --agc-danger: #dc2626;
      --agc-danger-bg: rgba(220, 38, 38, 0.08);
      --agc-warn-bg: rgba(217, 119, 6, 0.08);
      --agc-neutral-bg: rgba(0, 0, 0, 0.05);
      --agc-speed: #0284c7;
      --agc-c-sys: #6366f1;
      --agc-c-tool: #2563eb;
      --agc-c-ast: #059669;
      --agc-c-thk: #9333ea;
      --agc-c-usr: #d97706;
      --agc-c-sum: #0d9488;
      --agc-c-att: #ea580c;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .agc-strip {
      display: inline-flex;
      align-items: center;
      gap: 0px;
      position: relative;
    }
    .agc-grp {
      display: inline-flex;
      align-items: center;
      position: static;
    }
    .agc-pill {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 5px;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: var(--agc-muted);
      font: inherit;
      font-size: 12.5px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      cursor: default;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .agc-grp[data-open="true"] .agc-pill,
    .agc-pill:hover {
      background: var(--agc-pill-hover);
      color: var(--agc-fg-strong);
    }
    .agc-grp[data-pinned="true"] .agc-pill {
      background: var(--agc-pill-hover);
      color: var(--agc-fg-strong);
    }
    .agc-pill-quota { gap: 8px; }
    .agc-q-pair {
      display: inline-flex;
      align-items: center;
      gap: 4.5px;
      transition: color 0.12s ease;
    }
    .agc-q-pair[data-tone="warn"] { color: var(--agc-warn); }
    .agc-q-pair[data-tone="danger"] { color: var(--agc-danger); }
    .agc-svg {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
      transition: color 0.12s ease;
    }
    .agc-val {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .agc-speed {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding-left: 5px;
      margin-left: 1px;
      border-left: 1px solid var(--agc-divider);
      font-size: 11.5px;
      font-weight: 500;
      color: var(--agc-speed);
      transition: color 0.35s ease, opacity 0.35s ease;
    }
    .agc-speed[data-tier="fast"],
    .agc-speed[data-tier="smooth"] { color: var(--agc-good); }
    .agc-speed[data-tier="fair"] { color: var(--agc-warn); }
    .agc-speed[data-tier="slow"] { color: var(--agc-danger); }
    .agc-speed[data-state="idle"] { color: var(--agc-muted); }
    .agc-grp[data-open="true"] .agc-speed[data-state="idle"],
    .agc-pill:hover .agc-speed[data-state="idle"] { color: var(--agc-fg); }
    .agc-live-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      transition: opacity 0.35s ease, transform 0.35s ease;
    }
    .agc-speed[data-state="active"] .agc-live-dot {
      animation: agc-pulse 1.2s ease-in-out infinite;
    }
    .agc-speed[data-state="recent"] .agc-live-dot {
      opacity: 0.9;
    }
    .agc-speed[data-state="idle"] .agc-live-dot {
      opacity: 0.48;
    }
    @keyframes agc-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.78); }
    }

    /* Progressive narrow degradation classes */
    .agc-strip.agc-hide-speed [data-el="pillSpeed"] { display: none !important; }
    .agc-strip.agc-hide-wk [data-el="pairWk"],
    .agc-strip.agc-hide-5h [data-el="pair5h"] { display: none; }
    .agc-strip.agc-hide-wk .agc-pill-quota,
    .agc-strip.agc-hide-5h .agc-pill-quota { gap: 0; }
    .agc-strip.agc-hide-qval [data-el="grpQuota"] .agc-val { display: none; }
    .agc-strip.agc-hide-qval [data-el="grpQuota"] .agc-q-pair { gap: 0; }
    .agc-strip.agc-hide-cval [data-el="grpCtx"] .agc-val { display: none; }
    .agc-strip.agc-hide-cval [data-el="grpCtx"] .agc-pill { gap: 0; }
    .agc-strip.agc-hide-quota [data-el="grpQuota"] { display: none; }
    .agc-strip.agc-hide-all { display: none !important; }

    /* Outer wrapper owns hover bridge OUTSIDE scrollable card */
    .agc-pop-wrap {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 0;
      z-index: 2147483640;
      overflow: visible;
      pointer-events: auto;
    }
    .agc-pop-wrap::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -10px;
      height: 10px;
      background: transparent;
    }
    .agc-grp[data-open="true"] .agc-pop-wrap {
      display: block;
    }

    /* Minimalist Inner Card */
    .agc-pop {
      background: var(--agc-pop-bg);
      backdrop-filter: blur(22px);
      border: 1px solid var(--agc-pop-border);
      border-radius: 10px;
      padding: 11px 13px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.04);
      color: var(--agc-muted);
      font-size: 13px;
      line-height: 1.35;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: rgba(142, 142, 147, 0.28) transparent;
    }
    .agc-pop::-webkit-scrollbar { width: 4px; height: 4px; }
    .agc-pop::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
    .agc-pop::-webkit-scrollbar-track { background: transparent; }
    .agc-pop::-webkit-scrollbar-thumb { background: rgba(142, 142, 147, 0.28); border-radius: 999px; }

    .agc-ctx-pop {
      width: 248px;
      max-width: calc(100vw - 16px);
      max-height: min(520px, calc(100vh - 96px));
    }
    .agc-quota-pop {
      width: 240px;
      max-width: calc(100vw - 16px);
      max-height: min(480px, calc(100vh - 96px));
    }

    /* Row 1: Cache Bar + Quiet Ghost Actions */
    .agc-cache-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding-bottom: 6px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--agc-divider);
    }
    .agc-cache-left {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: var(--agc-fg);
      white-space: nowrap;
      min-width: 0;
    }
    .agc-cache-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 11px;
      height: 11px;
      flex-shrink: 0;
    }
    .agc-cache-name {
      color: var(--agc-fg-strong);
    }
    .agc-cache-pct {
      font-variant-numeric: tabular-nums;
      color: var(--agc-muted);
      font-weight: 400;
    }
    .agc-cache-badge {
      font-size: 11.5px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      margin-left: 2px;
    }
    .agc-actions {
      display: inline-flex;
      align-items: center;
      gap: 1px;
      flex-shrink: 0;
      opacity: 0.52;
      transition: opacity 0.14s ease;
    }
    .agc-pop:hover .agc-actions,
    .agc-grp[data-pinned="true"] .agc-actions {
      opacity: 1;
    }
    .agc-icon-btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 19px;
      min-width: 19px;
      padding: 0 3px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--agc-muted);
      font: inherit;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .agc-icon-btn:hover {
      background: var(--agc-pill-hover);
      color: var(--agc-fg-strong);
    }
    .agc-icon-btn[data-busy="true"] svg {
      animation: agc-spin 0.8s linear infinite;
    }
    @keyframes agc-spin { to { transform: rotate(360deg); } }

    /* Row 2: Summary Line + 4px Bar */
    .agc-summary-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 6px;
    }
    .agc-used-pct {
      font-size: 13px;
      font-weight: 600;
      color: var(--agc-fg-strong);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .agc-used-frac {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--agc-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .agc-frac-main {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--agc-fg);
    }
    .agc-frac-cap {
      font-size: 11.5px;
      font-weight: 400;
      color: var(--agc-muted);
    }
    .agc-track {
      position: relative;
      width: 100%;
      height: 4px;
      background: var(--agc-track);
      border-radius: 999px;
      display: flex;
      gap: 1.5px;
      overflow: hidden;
      margin-bottom: 9px;
    }
    .agc-seg {
      height: 100%;
      border-radius: 999px;
      transition: width 0.25s ease;
    }

    .agc-alert {
      display: block;
      padding: 4px 7px;
      border-radius: 5px;
      font-size: 11px;
      line-height: 1.4;
      margin-bottom: 8px;
      word-break: break-word;
    }
    .agc-alert > span {
      display: inline;
    }
    .agc-alert[data-tone="danger"] { background: var(--agc-danger-bg); color: var(--agc-danger); }
    .agc-alert[data-tone="warn"] { background: var(--agc-warn-bg); color: var(--agc-warn); }
    .agc-alert[data-tone="neutral"] { background: var(--agc-neutral-bg); color: var(--agc-muted); }
    .agc-cmd {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.25;
      padding: 0 3.5px;
      border-radius: 3px;
      background: rgba(128, 128, 128, 0.18);
      white-space: nowrap;
      vertical-align: 0.5px;
    }

    /* Block 3: 7-Category 3-Column Tabular List */
    .agc-list {
      display: grid;
      grid-template-columns: 1fr auto minmax(40px, auto);
      row-gap: 5px;
      column-gap: 10px;
      align-items: center;
      font-size: 12.5px;
    }
    .agc-item-row { display: contents; }
    .agc-item-row[data-zero="true"] > *,
    .agc-item-row[data-tier="dim"] > * {
      opacity: 0.44;
      transition: opacity 0.14s ease;
    }
    .agc-item-row[data-tier="dim"]:hover > * {
      opacity: 0.92;
    }
    .agc-item-left {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--agc-muted);
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agc-dot {
      width: 6.5px;
      height: 6.5px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .agc-item-pct {
      text-align: right;
      justify-self: end;
      color: var(--agc-fg);
      font-weight: 500;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .agc-item-k {
      text-align: right;
      justify-self: end;
      font-size: 11.5px;
      color: var(--agc-muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .agc-item-row[data-tier="dom"] .agc-item-left {
      color: var(--agc-fg-strong);
      font-weight: 500;
    }
    .agc-item-row[data-tier="dom"] .agc-item-pct {
      color: var(--agc-fg-strong);
      font-weight: 600;
    }
    .agc-item-row[data-tier="dom"] .agc-item-k {
      color: var(--agc-fg);
      font-weight: 500;
    }
    .agc-item-row[data-tier="dim"] .agc-item-pct {
      color: var(--agc-muted);
      font-weight: 400;
    }

    /* Block 4: Hairline Divider + Minimalist 2-Line Telemetry */
    .agc-divider {
      height: 1px;
      background: var(--agc-divider);
      margin: 8.5px 0;
    }
    .agc-tele-row1 {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      margin-bottom: 3px;
    }
    .agc-tele-speed {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
    }
    .agc-tele-main {
      font-weight: 500;
      color: var(--agc-fg);
      white-space: nowrap;
    }
    .agc-tele-tier {
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .agc-tele-main[data-tier="fast"],
    .agc-tele-main[data-tier="smooth"],
    .agc-tele-tier[data-tier="fast"],
    .agc-tele-tier[data-tier="smooth"] { color: var(--agc-good); }
    .agc-tele-main[data-tier="fair"],
    .agc-tele-tier[data-tier="fair"] { color: var(--agc-warn); }
    .agc-tele-main[data-tier="slow"],
    .agc-tele-tier[data-tier="slow"] { color: var(--agc-danger); }
    .agc-tele-muted {
      color: var(--agc-muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .agc-out-val {
      color: var(--agc-fg);
      font-weight: 500;
    }
    .agc-tele-row2 {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 11.5px;
      color: var(--agc-muted);
      font-variant-numeric: tabular-nums;
    }
    .agc-tele-row2 > span {
      white-space: nowrap;
    }

    /* Minimalist Quota Popover */
    .agc-q-group {
      transition: opacity 0.14s ease;
    }
    .agc-q-group[data-dim="true"] {
      opacity: 0.78;
    }
    .agc-q-group[data-dim="true"]:hover {
      opacity: 1;
    }
    .agc-q-group + .agc-q-group {
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid var(--agc-divider);
    }
    .agc-q-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
    }
    .agc-q-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--agc-fg);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .agc-q-group[data-active="true"] .agc-q-title {
      color: var(--agc-fg-strong);
    }
    .agc-q-active {
      display: inline-flex;
      align-items: center;
      gap: 4.5px;
      font-size: 11px;
      font-weight: 500;
      color: var(--agc-good);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .agc-q-active-dot {
      width: 5.5px;
      height: 5.5px;
      border-radius: 50%;
      background: var(--agc-good);
      flex-shrink: 0;
    }
    .agc-q-rows {
      display: grid;
      grid-template-columns: minmax(44px, auto) 1fr minmax(34px, auto) minmax(46px, auto);
      column-gap: 9px;
      row-gap: 5.5px;
      align-items: center;
      font-size: 12.5px;
      font-variant-numeric: tabular-nums;
    }
    .agc-q-row { display: contents; }
    .agc-q-label {
      color: var(--agc-muted);
      white-space: nowrap;
    }
    .agc-q-bar {
      width: 100%;
      min-width: 40px;
      height: 4px;
      background: var(--agc-track);
      border-radius: 999px;
      overflow: hidden;
    }
    .agc-q-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--agc-good);
      transition: width 0.25s ease;
    }
    .agc-q-fill[data-tone="warn"] { background: var(--agc-warn); }
    .agc-q-fill[data-tone="danger"] { background: var(--agc-danger); }
    .agc-q-pct {
      text-align: right;
      justify-self: end;
      font-weight: 500;
      color: var(--agc-fg);
      white-space: nowrap;
    }
    .agc-q-pct[data-tone="warn"] { color: var(--agc-warn); }
    .agc-q-pct[data-tone="danger"] { color: var(--agc-danger); font-weight: 600; }
    .agc-q-reset {
      text-align: right;
      justify-self: end;
      font-size: 11.5px;
      color: var(--agc-muted);
      white-space: nowrap;
    }
    .agc-q-empty { color: var(--agc-muted); font-size: 12.5px; }
  `;

  shadow.innerHTML = `
    <style>${STYLES}</style>
    <div class="agc-strip" data-el="strip">
      <!-- Context Capsule + Popover -->
      <div class="agc-grp" data-el="grpCtx" data-open="false" data-pinned="false">
        <button class="agc-pill" type="button" data-el="btnCtx" aria-expanded="false">
          <svg class="agc-svg" data-el="ctxIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
            <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"></path>
            <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"></path>
          </svg>
          <span class="agc-val" data-el="pillCtx">--%</span>
          <span class="agc-speed" data-el="pillSpeed" hidden>
            <span class="agc-live-dot" data-el="liveDot" hidden></span>
            <span data-el="pillSpeedVal"></span>
          </span>
        </button>

        <div class="agc-pop-wrap" data-el="popCtxWrap">
          <div class="agc-pop agc-ctx-pop" data-el="popCtx" role="dialog" aria-label="Context details">
            <!-- Row 1: Cache Bar + Quiet Ghost Actions -->
            <div class="agc-cache-bar" data-el="cacheRow">
              <div class="agc-cache-left">
                <span class="agc-cache-icon" data-el="cacheIcon"></span>
                <span class="agc-cache-name" data-el="cacheLabel">Cache</span>
                <span class="agc-cache-pct" data-el="cachePct">0%</span>
                <span class="agc-cache-badge" data-el="cacheBadge" hidden></span>
              </div>
              <div class="agc-actions">
                <button class="agc-icon-btn" type="button" data-el="btnRefresh" title="Rescan">
                  <svg viewBox="0 0 16 16" width="11.5" height="11.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.45-3.72M13.5 2.5v3.2h-3.2"></path>
                  </svg>
                </button>
                <button class="agc-icon-btn" type="button" data-el="btnLang">EN</button>
                <button class="agc-icon-btn" type="button" data-el="btnTheme">
                  <svg viewBox="0 0 16 16" width="11.5" height="11.5" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <circle cx="8" cy="8" r="5.5"></circle>
                    <path d="M8 2.5v11"></path>
                    <path d="M8 2.5a5.5 5.5 0 0 1 0 11" fill="currentColor" fill-opacity="0.25" stroke="none"></path>
                  </svg>
                </button>
              </div>
            </div>

            <!-- Row 2: Summary Line + 4px Bar -->
            <div class="agc-summary-row">
              <div class="agc-used-pct" data-el="heroPct">0% used</div>
              <div class="agc-used-frac" data-el="heroFrac">0 / 256k</div>
            </div>

            <div class="agc-track" data-el="track">
              <div class="agc-seg" data-seg="system" style="width:0%;background:var(--agc-c-sys)"></div>
              <div class="agc-seg" data-seg="tools" style="width:0%;background:var(--agc-c-tool)"></div>
              <div class="agc-seg" data-seg="assistant" style="width:0%;background:var(--agc-c-ast)"></div>
              <div class="agc-seg" data-seg="thinking" style="width:0%;background:var(--agc-c-thk)"></div>
              <div class="agc-seg" data-seg="user" style="width:0%;background:var(--agc-c-usr)"></div>
              <div class="agc-seg" data-seg="summaries" style="width:0%;background:var(--agc-c-sum)"></div>
              <div class="agc-seg" data-seg="attachment-total" style="width:0%;background:var(--agc-c-att)"></div>
            </div>

            <div class="agc-alert" data-el="alertBanner" hidden></div>

            <!-- Block 3: 7-Category 3-Column Tabular List -->
            <div class="agc-list">
              <div class="agc-item-row" data-row="system">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-sys)"></span><span data-el="catSystem">System</span></div>
                <div class="agc-item-pct" data-val="system">—</div>
                <div class="agc-item-k" data-k="system">—</div>
              </div>
              <div class="agc-item-row" data-row="tools">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-tool)"></span><span data-el="catTools">Tools</span></div>
                <div class="agc-item-pct" data-val="tools">—</div>
                <div class="agc-item-k" data-k="tools">—</div>
              </div>
              <div class="agc-item-row" data-row="assistant">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-ast)"></span><span data-el="catAssistant">Model</span></div>
                <div class="agc-item-pct" data-val="assistant">—</div>
                <div class="agc-item-k" data-k="assistant">—</div>
              </div>
              <div class="agc-item-row" data-row="thinking">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-thk)"></span><span data-el="catThinking">Think</span></div>
                <div class="agc-item-pct" data-val="thinking">—</div>
                <div class="agc-item-k" data-k="thinking">—</div>
              </div>
              <div class="agc-item-row" data-row="user">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-usr)"></span><span data-el="catUser">User</span></div>
                <div class="agc-item-pct" data-val="user">—</div>
                <div class="agc-item-k" data-k="user">—</div>
              </div>
              <div class="agc-item-row" data-row="summaries">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-sum)"></span><span data-el="catSummaries">Summary</span></div>
                <div class="agc-item-pct" data-val="summaries">—</div>
                <div class="agc-item-k" data-k="summaries">—</div>
              </div>
              <div class="agc-item-row" data-row="attachment-total">
                <div class="agc-item-left"><span class="agc-dot" style="background:var(--agc-c-att)"></span><span data-el="catAttachment">Files</span></div>
                <div class="agc-item-pct" data-val="attachment-total">—</div>
                <div class="agc-item-k" data-k="attachment-total">—</div>
              </div>
            </div>

            <!-- Block 4: Hairline Divider + Minimalist 2-Line Generation Telemetry -->
            <div class="agc-divider"></div>
            <div class="agc-tele-row1">
              <div class="agc-tele-speed">
                <span class="agc-tele-main" data-el="valSpeed">—</span>
                <span class="agc-tele-tier" data-el="speedTier" hidden></span>
              </div>
              <span class="agc-tele-muted" data-el="valOut">—</span>
            </div>
            <div class="agc-tele-row2">
              <span data-el="valTiming">—</span>
              <span data-el="valSteps">—</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Quota Capsule + Popover -->
      <div class="agc-grp" data-el="grpQuota" data-open="false" data-pinned="false">
        <button class="agc-pill agc-pill-quota" type="button" data-el="btnQuota" aria-expanded="false">
          <span class="agc-q-pair" data-el="pair5h">
            <svg class="agc-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15.5 14"></polyline>
            </svg>
            <span class="agc-val" data-el="pill5h">--%</span>
          </span>
          <span class="agc-q-pair" data-el="pairWk">
            <svg class="agc-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span class="agc-val" data-el="pillWk">--%</span>
          </span>
        </button>

        <div class="agc-pop-wrap" data-el="popQuotaWrap">
          <div class="agc-pop agc-quota-pop" data-el="popQuota" role="dialog" aria-label="Model quotas">
            <div data-el="quotaRoot"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const el = (name) => shadow.querySelector(`[data-el="${name}"]`);

  function ensureHostStyles() {
    if (!document?.head || document.getElementById('agy-capsule-host-squeeze')) return;
    const style = document.createElement('style');
    style.id = 'agy-capsule-host-squeeze';
    style.textContent = `
      .agc-fl-squeezed { min-width: 0 !important; flex-shrink: 1 !important; }
      .agc-model-squeezed { min-width: 0 !important; flex: 0 1 auto !important; overflow: hidden !important; max-width: 100% !important; }
      .agc-model-squeezed .agc-squeeze-box,
      .agc-model-squeezed .agc-squeeze-item {
        min-width: 0 !important; max-width: 100% !important; overflow: hidden !important;
        text-overflow: ellipsis !important; white-space: nowrap !important;
      }
      .agc-model-squeezed .agc-squeeze-box,
      .agc-model-squeezed-hard .agc-squeeze-item { flex-shrink: 1 !important; }
      .agc-model-squeezed svg { flex-shrink: 0 !important; }
    `;
    document.head.appendChild(style);
  }

  let observedFooterLeft = null;
  let modelObserver = null;
  let resizeObserver = null;
  let bodyObserver = null;
  let themeAttrObserver = null;
  let isAdjustingLayout = false;
  let layoutRafId = 0;
  let dockPending = false;

  function isInFlowVisible(elNode) {
    if (!elNode) return false;
    if (typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(elNode);
      if (
        cs.display === 'none' ||
        cs.visibility === 'hidden' ||
        parseFloat(cs.opacity || '1') === 0 ||
        cs.position === 'fixed' ||
        cs.position === 'absolute'
      ) {
        return false;
      }
    }
    return true;
  }

  function findFooterLeft() {
    try {
      const nodes = document.querySelectorAll?.('.agy-composer-footer > div:first-child');
      if (!nodes || nodes.length === 0) {
        return document.querySelector?.('.agy-composer-footer > div:first-child') || null;
      }
      let best = null;
      let bestW = -1;
      for (const node of nodes) {
        if (!isInFlowVisible(node)) continue;
        const r = node.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0 && r.width > bestW) {
          best = node;
          bestW = r.width;
        }
      }
      if (best) return best;
      for (const node of nodes) {
        if (isInFlowVisible(node)) return node;
      }
      return nodes[0] || null;
    } catch {
      return null;
    }
  }

  function readComposerModelText(footerLeft) {
    if (!footerLeft) return '';
    let mt = '';
    for (const child of footerLeft.children || []) {
      if (child !== host && child.textContent) {
        mt += ' ' + child.textContent.trim();
      }
    }
    return mt.trim();
  }

  function applyTheme() {
    const active = resolveTheme();
    host.setAttribute('data-theme', active);
    const t = getDict();
    const themeBtn = el('btnTheme');
    if (themeBtn) {
      const mode = state.prefs?.themeMode || 'auto';
      const label = mode === 'auto' ? t.themeAuto(active === 'light') : mode === 'light' ? t.themeLight : t.themeDark;
      themeBtn.title = t.themeTitle(label);
    }
  }

  function applyStaticLabels() {
    const lang = resolveLanguage();
    const t = getDict();
    host.setAttribute('lang', lang);

    el('btnCtx')?.setAttribute('aria-label', t.ctxCapsuleAria);
    el('btnQuota')?.setAttribute('aria-label', t.quotaCapsuleAria);
    if (el('cacheLabel')) el('cacheLabel').textContent = t.cacheLabel;
    if (el('btnRefresh')) el('btnRefresh').title = t.refreshTitle;
    const btnLang = el('btnLang');
    if (btnLang) {
      btnLang.textContent = t.langShort;
      const isAuto = !state.prefs?.langMode || state.prefs.langMode === 'auto';
      btnLang.title = isAuto ? t.langTitleAuto(t.langName) : t.langTitlePinned(t.langName);
    }

    if (el('catSystem')) el('catSystem').textContent = t.catSystem;
    if (el('catTools')) el('catTools').textContent = t.catTools;
    if (el('catAssistant')) el('catAssistant').textContent = t.catAssistant;
    if (el('catThinking')) el('catThinking').textContent = t.catThinking;
    if (el('catUser')) el('catUser').textContent = t.catUser;
    if (el('catSummaries')) el('catSummaries').textContent = t.catSummaries;
    if (el('catAttachment')) el('catAttachment').textContent = t.catAttachment;

    applyTheme();
  }

  function positionPopover(key) {
    const wrap = key === 'ctx' ? el('popCtxWrap') : el('popQuotaWrap');
    const pop = key === 'ctx' ? el('popCtx') : el('popQuota');
    const grp = key === 'ctx' ? el('grpCtx') : el('grpQuota');
    if (!wrap || !pop || !grp) return;
    try {
      wrap.style.left = '';
      const grpRect = grp.getBoundingClientRect?.();
      const pr = wrap.getBoundingClientRect?.();
      if (!pr || pr.width <= 0) return;
      const vw = window.innerWidth || 1280;
      const maxRight = vw - 8;
      if (pr.right > maxRight) {
        wrap.style.left = `${Math.max(-pr.left + 8, maxRight - pr.right)}px`;
      } else if (pr.left < 8) {
        wrap.style.left = `${8 - pr.left}px`;
      }
      if (grpRect && grpRect.top > 40) {
        pop.style.maxHeight = `${Math.min(520, Math.max(180, Math.floor(grpRect.top - 16)))}px`;
      }
    } catch {}
  }

  function syncPopoverVisibility() {
    for (const [key, grpName, btnName] of [
      ['ctx', 'grpCtx', 'btnCtx'],
      ['quota', 'grpQuota', 'btnQuota'],
    ]) {
      const grp = el(grpName);
      const btn = el(btnName);
      const isOpen = state.openPop === key;
      const isPinned = state.pinnedPop === key;
      if (grp) {
        grp.setAttribute('data-open', isOpen ? 'true' : 'false');
        grp.setAttribute('data-pinned', isPinned ? 'true' : 'false');
      }
      if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) positionPopover(key);
    }
  }

  let hoverCloseTimer = null;
  function clearHoverTimer() {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function openPopover(key, pin = false) {
    clearHoverTimer();
    const prevOpen = state.openPop;
    if (pin) {
      state.pinnedPop = state.pinnedPop === key ? null : key;
      state.openPop = state.pinnedPop;
    } else if (!state.pinnedPop || state.pinnedPop === key) {
      state.openPop = key;
    }
    if (state.openPop && state.openPop !== prevOpen) {
      renderCacheAndCountdowns();
    }
    syncPopoverVisibility();
  }

  function scheduleClosePopover(key) {
    clearHoverTimer();
    if (state.pinnedPop === key) return;
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      if (!state.pinnedPop && state.openPop === key) {
        state.openPop = null;
        syncPopoverVisibility();
      } else if (state.pinnedPop && state.pinnedPop !== key) {
        state.openPop = state.pinnedPop;
        syncPopoverVisibility();
      }
    }, 130);
  }

  function closeAllPopovers() {
    clearHoverTimer();
    state.openPop = null;
    state.pinnedPop = null;
    syncPopoverVisibility();
  }

  function quotaTone(pct) {
    if (pct == null || Number.isNaN(Number(pct))) return '';
    if (Number(pct) <= 10) return 'danger';
    if (Number(pct) <= 25) return 'warn';
    return '';
  }

  function syncModelQuotaPills() {
    const footerLeft = findFooterLeft();
    const modelText = readComposerModelText(footerLeft);
    const matched = matchModelQuotaGroup(modelText, state.quotaGroups);
    state.matchedGroup = matched;

    const pill5h = el('pill5h');
    const pillWk = el('pillWk');
    const pair5h = el('pair5h');
    const pairWk = el('pairWk');
    const strip = el('strip');
    const q5hPct = matched && matched.q5hPct != null ? matched.q5hPct : null;
    const qWkPct = matched && matched.qWkPct != null ? matched.qWkPct : null;
    const q5hStr = q5hPct != null ? `${q5hPct}%` : '--%';
    const qWkStr = qWkPct != null ? `${qWkPct}%` : '--%';
    if (pill5h) pill5h.textContent = q5hStr;
    if (pillWk) pillWk.textContent = qWkStr;
    if (pair5h) {
      const tone5h = quotaTone(q5hPct);
      if (tone5h) pair5h.setAttribute('data-tone', tone5h);
      else pair5h.removeAttribute('data-tone');
      pair5h.hidden = Boolean(matched && q5hPct == null && qWkPct != null);
    }
    if (pairWk) {
      const toneWk = quotaTone(qWkPct);
      if (toneWk) pairWk.setAttribute('data-tone', toneWk);
      else pairWk.removeAttribute('data-tone');
      pairWk.hidden = Boolean(matched && qWkPct == null && q5hPct != null);
    }
    if (strip) {
      strip.dataset.preferWkOnly = q5hStr === '--%' && qWkStr !== '--%' ? '1' : '0';
    }
  }

  function getNativeVisualInfo(nodeRoot) {
    let maxR = -Infinity;
    let svgClipped = false;
    const walk = (node, parentClip) => {
      if (!node) return;
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
      if (cs) {
        if (
          cs.display === 'none' ||
          cs.visibility === 'hidden' ||
          parseFloat(cs.opacity || '1') === 0 ||
          cs.position === 'fixed' ||
          cs.position === 'absolute'
        ) {
          return;
        }
        if (cs.display === 'contents') {
          for (const child of node.children || []) walk(child, parentClip);
          return;
        }
      }
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const r = node.getBoundingClientRect?.();
      if (!r) return;
      if (r.width > 0 || r.height > 0) {
        if (tag === 'svg') {
          if (parentClip < Infinity && r.width > 0 && r.right > parentClip + 1) svgClipped = true;
          const visR = Math.min(r.right, parentClip);
          if (visR > maxR) maxR = visR;
          return;
        }
        const visR = Math.min(r.right, parentClip);
        if (visR > maxR) maxR = visR;
        const ownClip = cs && (cs.overflowX === 'hidden' || cs.overflowX === 'clip') ? r.right : Infinity;
        const nextClip = Math.min(parentClip, ownClip);
        if (cs && cs.overflowX === 'visible' && node.scrollWidth > node.clientWidth + 1) {
          const overflowR = Math.min(r.left + node.scrollWidth, parentClip);
          if (overflowR > maxR) maxR = overflowR;
        }
        for (const child of node.children || []) walk(child, nextClip);
      } else {
        for (const child of node.children || []) walk(child, parentClip);
      }
    };
    walk(nodeRoot, Infinity);
    return { maxR, svgClipped };
  }

  function scheduleAdjustLayout() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame !== 'function') {
      adjustLayout();
      return;
    }
    if (layoutRafId) return;
    layoutRafId = requestAnimationFrame(() => {
      layoutRafId = 0;
      if (!state.disposed) adjustLayout();
    });
  }

  function adjustLayout() {
    if (isAdjustingLayout || state.disposed) return;
    const strip = el('strip');
    const footerLeft = findFooterLeft();
    if (!strip || !footerLeft) return;

    isAdjustingLayout = true;
    try {
      const footer = footerLeft.parentElement;
      const allLeftChildren = Array.from(footerLeft.children || []);
      const hostIdx = allLeftChildren.indexOf(host);
      const leftSiblings = (
        hostIdx >= 0 ? allLeftChildren.slice(0, hostIdx) : allLeftChildren.filter((c) => c !== host)
      ).filter((c) => isInFlowVisible(c));
      const modelTargets = leftSiblings.filter((c) => c.textContent && c.textContent.trim().length > 0);

      const syncSqueeze = (compress) => {
        footerLeft.classList?.toggle('agc-fl-squeezed', !!compress);
        for (const mt of modelTargets) {
          mt.classList?.toggle('agc-model-squeezed', !!compress);
          mt.classList?.toggle('agc-model-squeezed-hard', compress === 'hard');
          if (!compress) {
            mt.classList?.remove('agc-squeeze-box', 'agc-squeeze-item');
            for (const node of mt.querySelectorAll?.('.agc-squeeze-box, .agc-squeeze-item') || []) {
              node.classList?.remove('agc-squeeze-box', 'agc-squeeze-item');
            }
            continue;
          }
          const tagNode = (elNode) => {
            const txt = elNode.textContent ? elNode.textContent.trim() : '';
            if (!txt) {
              elNode.classList?.remove('agc-squeeze-box', 'agc-squeeze-item');
              return;
            }
            const isBoxOrLong = (elNode.children?.length || 0) > 0 || txt.length > 5;
            elNode.classList?.toggle('agc-squeeze-box', isBoxOrLong);
            elNode.classList?.toggle('agc-squeeze-item', !isBoxOrLong);
          };
          tagNode(mt);
          for (const elNode of mt.querySelectorAll?.('div, span, button, a, p, label') || []) tagNode(elNode);
        }
      };

      const compactCls = strip.dataset.preferWkOnly === '1' ? 'agc-hide-5h' : 'agc-hide-wk';
      const modeClasses = ['agc-hide-speed', 'agc-hide-wk', 'agc-hide-5h', 'agc-hide-qval', 'agc-hide-cval', 'agc-hide-quota', 'agc-hide-all'];
      const modes = [
        { classes: [], compress: '' },
        { classes: ['agc-hide-speed'], compress: '' },
        { classes: ['agc-hide-speed', compactCls], compress: '' },
        { classes: ['agc-hide-speed', compactCls, 'agc-hide-qval'], compress: '' },
        { classes: ['agc-hide-speed', compactCls, 'agc-hide-qval', 'agc-hide-cval'], compress: '' },
        { classes: ['agc-hide-speed', compactCls, 'agc-hide-qval', 'agc-hide-cval'], compress: 'soft' },
        { classes: ['agc-hide-speed', compactCls, 'agc-hide-qval', 'agc-hide-cval'], compress: 'hard' },
        { classes: ['agc-hide-speed', 'agc-hide-cval', 'agc-hide-quota'], compress: 'hard' },
        { classes: ['agc-hide-all'], compress: '' },
      ];

      const clearModes = () => {
        for (const cls of modeClasses) strip.classList.remove(cls);
        syncSqueeze('');
      };

      const footerRect = footer?.getBoundingClientRect?.();
      if (!footerRect || footerRect.width <= 0) {
        clearModes();
        return;
      }

      const isControlGroup = (elNode) => {
        if (!elNode) return false;
        if (elNode.textContent && elNode.textContent.trim().length > 0) return true;
        return Boolean(elNode.querySelector?.('button, svg, img, input, a, [role="button"]'));
      };
      const isClippedEl = (elNode) => {
        if (typeof SVGElement !== 'undefined' && elNode instanceof SVGElement) return false;
        const cs = typeof getComputedStyle === 'function' ? getComputedStyle(elNode) : null;
        if (!cs || (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip')) return false;
        if ((elNode.scrollWidth || 0) <= (elNode.clientWidth || 0) + 2) return false;
        const r = elNode.getBoundingClientRect?.();
        return r ? r.height > 0 : false;
      };

      const isNativeSqueezed = () => {
        for (const c of leftSiblings) {
          if (isClippedEl(c)) return true;
          for (const node of c.querySelectorAll?.('*') || []) {
            if (isClippedEl(node)) return true;
          }
        }
        return false;
      };

      for (let i = 0; i < modes.length; i++) {
        const mode = modes[i];
        for (const cls of modeClasses) {
          strip.classList.toggle(cls, mode.classes.includes(cls));
        }
        syncSqueeze(mode.compress);
        if (mode.classes.includes('agc-hide-all')) break;

        const rootRect = strip.getBoundingClientRect?.();
        if (!rootRect || rootRect.width <= 0) {
          if (i === 0) {
            clearModes();
            return;
          }
          continue;
        }

        const footerLeftRect = footerLeft.getBoundingClientRect?.();
        const flLeftEdge = footerLeftRect ? footerLeftRect.left : footerRect.left;

        const rightControls = footer
          ? Array.from(footer.children || []).filter((c) => {
              if (c === footerLeft || !isInFlowVisible(c) || !isControlGroup(c)) return false;
              const r = c.getBoundingClientRect?.();
              if (!r || r.width <= 0 || r.height <= 0 || r.left < flLeftEdge + 20) return false;
              return !footerLeftRect || (r.bottom > footerLeftRect.top + 2 && r.top < footerLeftRect.bottom - 2);
            })
          : [];
        const rightMinLeft =
          rightControls.length > 0
            ? Math.min(...rightControls.map((c) => c.getBoundingClientRect().left))
            : Infinity;
        const footerCs = footer && typeof getComputedStyle === 'function' ? getComputedStyle(footer) : null;
        const footerRightEdge = footer
          ? footer.getBoundingClientRect().right - (parseFloat(footerCs?.paddingRight) || 0)
          : Infinity;
        const flCs = typeof getComputedStyle === 'function' ? getComputedStyle(footerLeft) : null;
        const flClipRight =
          flCs && flCs.overflowX !== 'visible' && footerLeftRect ? footerLeftRect.right + 2 : Infinity;
        const minRightBound = Math.min(rightMinLeft, footerRightEdge, flClipRight);
        const availFooterWidth = Math.min(rightMinLeft, footerRightEdge) - flLeftEdge;

        let nativeMaxRight = -Infinity;
        let anySvgClipped = false;
        for (const c of leftSiblings) {
          const info = getNativeVisualInfo(c);
          if (info.maxR > nativeMaxRight) nativeMaxRight = info.maxR;
          if (info.svgClipped) anySvgClipped = true;
        }

        const fitsRight =
          rootRect.right <= rightMinLeft - 4 &&
          rootRect.right <= footerRightEdge + 2 &&
          rootRect.right <= flClipRight;
        const fitsLeft = nativeMaxRight === -Infinity || rootRect.left >= nativeMaxRight - 1;
        const crowdedModel = !mode.compress && minRightBound - rootRect.right < 24 && isNativeSqueezed();
        if (fitsRight && fitsLeft && !(mode.compress && anySvgClipped) && !crowdedModel) break;

        // Hard floor: keep at least the single context icon on any composer >= 120px wide
        const nextMode = modes[i + 1];
        if (nextMode && nextMode.classes.includes('agc-hide-all') && availFooterWidth >= 120) {
          break;
        }
      }
    } finally {
      isAdjustingLayout = false;
    }
  }

  let lastQuotaRenderedHtml = '';
  let speedCoolTimer = null;

  const fmtSec = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(Number(v) >= 10 ? 1 : 2)}s`);

  function clearSpeedCoolTimer() {
    if (speedCoolTimer) {
      clearTimeout(speedCoolTimer);
      speedCoolTimer = null;
    }
  }

  function scheduleSpeedCoolTimer(nowMs = Date.now()) {
    clearSpeedCoolTimer();
    if (state.disposed || state.isTurnInFlight || state.speedCoolUntilMs <= nowMs) return;
    const delayMs = Math.max(50, state.speedCoolUntilMs - nowMs + 25);
    speedCoolTimer = setTimeout(() => {
      speedCoolTimer = null;
      if (!state.disposed) {
        renderSpeedPill(Date.now());
      }
    }, delayMs);
    speedCoolTimer?.unref?.();
  }

  function buildSpeedMeta(sp, t = getDict(), lang = resolveLanguage()) {
    const spTier = sp?.tps != null ? classifySpeed(sp.tps, lang) : null;
    let speedTip = '';
    if (sp?.tps != null) {
      const line1Parts = [];
      if (sp.streamingTps) line1Parts.push(t.speedStreamingTps(sp.streamingTps));
      if (sp.ttft != null) {
        const sharePct = sp.duration > 0 ? Math.round((sp.ttft / sp.duration) * 100) : null;
        line1Parts.push(t.speedTtftDetail(fmtSec(sp.ttft), sharePct));
      }
      speedTip = line1Parts.length > 0 ? `${line1Parts.join(' · ')}\n${t.speedLabelTitle}` : t.speedLabelTitle;
    }
    return { sp, spTier, speedTip };
  }

  function renderSpeedPill(nowMs = Date.now()) {
    const pillSpeed = el('pillSpeed');
    if (!pillSpeed) return;
    const pillSpeedVal = el('pillSpeedVal');
    const liveDot = el('liveDot');
    const sp = state.latest?.speed;
    const hasSpeed = sp?.tps != null;
    const showSpeed = Boolean(state.convId && (state.isTurnInFlight || hasSpeed));

    if (!showSpeed) {
      if (!pillSpeed.hidden) pillSpeed.hidden = true;
      if (pillSpeed.title) pillSpeed.title = '';
      if (pillSpeed.getAttribute('data-tier') !== null) pillSpeed.removeAttribute('data-tier');
      if (pillSpeed.getAttribute('data-state') !== null) pillSpeed.removeAttribute('data-state');
      return;
    }

    const { spTier, speedTip } = buildSpeedMeta(sp);
    const speedState = state.isTurnInFlight ? 'active' : state.speedCoolUntilMs > nowMs ? 'recent' : 'idle';
    const nextValText = hasSpeed ? `${sp.tps} tok/s` : '';
    const nextTier = spTier ? spTier.level : '';

    if (pillSpeed.hidden) pillSpeed.hidden = false;
    if (liveDot && liveDot.hidden) liveDot.hidden = false;
    if (pillSpeedVal) {
      if (pillSpeedVal.hidden !== !hasSpeed) pillSpeedVal.hidden = !hasSpeed;
      if (pillSpeedVal.textContent !== nextValText) pillSpeedVal.textContent = nextValText;
    }
    if (pillSpeed.title !== speedTip) pillSpeed.title = speedTip;
    if (pillSpeed.getAttribute('data-state') !== speedState) {
      pillSpeed.setAttribute('data-state', speedState);
    }
    if (nextTier) {
      if (pillSpeed.getAttribute('data-tier') !== nextTier) pillSpeed.setAttribute('data-tier', nextTier);
    } else if (pillSpeed.getAttribute('data-tier') !== null) {
      pillSpeed.removeAttribute('data-tier');
    }
  }

  function formatIdleAgeMinutes(idleSec) {
    const mins = Math.floor(Math.max(0, idleSec) / 60);
    if (mins <= 0) return '<1m';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }

  function renderCacheAndCountdowns(nowMs = Date.now()) {
    const t = getDict();
    const d = state.latest;
    const input = d?.input || 0;
    const cached = d?.cached || 0;
    const cacheHitPct = input > 0 ? Math.round((cached / input) * 100) : 0;
    const hasHistory = Boolean(state.convId && (d?.actual != null || input > 0) && d?.lastStepEpochMs);
    const idleSec = hasHistory ? Math.max(0, Math.floor((nowMs - d.lastStepEpochMs) / 1000)) : 0;

    const cacheIcon = el('cacheIcon');
    const cachePct = el('cachePct');
    const cacheBadge = el('cacheBadge');
    const cacheRow = el('cacheRow');
    const ctxIcon = el('ctxIcon');

    const agoStr = formatIdleAgeMinutes(idleSec);

    let iconTone = '';
    let nextIconState = '';
    let nextIconSvg = '';
    const nextPctText = `${cacheHitPct}%`;
    let nextPctDeco = 'none';
    let nextPctOpacity = '1';
    let nextPctColor = '';
    let nextPctWeight = '';
    let nextBadgeHidden = true;
    let nextBadgeText = '';
    let nextBadgeColor = '';
    let nextCacheTitle = '';

    if (hasHistory && idleSec >= 240) {
      iconTone = 'expired';
      nextIconState = 'expired';
      nextIconSvg =
        '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#e06c75" stroke-width="2" stroke-linecap="round"><line x1="2.2" y1="2.2" x2="9.8" y2="9.8"/><line x1="9.8" y1="2.2" x2="2.2" y2="9.8"/></svg>';
      nextPctDeco = 'line-through';
      nextPctOpacity = '0.5';
      nextBadgeHidden = false;
      nextBadgeText = t.cacheExpiredTag;
      nextBadgeColor = 'var(--agc-danger)';
      nextCacheTitle = t.cacheExpiredTip(cached.toLocaleString(), input.toLocaleString(), agoStr);
    } else if (hasHistory && idleSec >= 180) {
      iconTone = 'warning';
      nextIconState = 'warning';
      const remMin = Math.max(1, Math.ceil((240 - idleSec) / 60));
      nextIconSvg =
        '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#d4940a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.8"/><polyline points="6 3.5 6 6 7.8 7.2"/></svg>';
      nextPctColor = '#d4940a';
      nextBadgeHidden = false;
      nextBadgeText = `~${remMin}m`;
      nextBadgeColor = '#d4940a';
      nextCacheTitle = t.cacheWarnTip(cached.toLocaleString(), input.toLocaleString(), agoStr, remMin);
    } else {
      const cacheWarmHit = Boolean(hasHistory && cacheHitPct > 0);
      nextIconState = cacheWarmHit ? 'warm' : 'idle';
      const iconStroke = cacheWarmHit ? 'var(--agc-good)' : 'currentColor';
      nextIconSvg =
        `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="${iconStroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6.5 4.8 9.2 10 3"/></svg>`;
      nextPctColor = cacheWarmHit ? 'var(--agc-fg)' : '';
      nextPctWeight = cacheWarmHit ? '500' : '';
      nextBadgeHidden = true;
      nextCacheTitle =
        hasHistory && input > 0
          ? t.cacheWarmTip(cached.toLocaleString(), input.toLocaleString(), agoStr)
          : t.cacheIdleTip;
    }

    if (cacheIcon && cacheIcon.getAttribute('data-icon-state') !== nextIconState) {
      cacheIcon.setAttribute('data-icon-state', nextIconState);
      cacheIcon.innerHTML = nextIconSvg;
    }
    if (cachePct) {
      if (cachePct.textContent !== nextPctText) cachePct.textContent = nextPctText;
      if (cachePct.style.textDecoration !== nextPctDeco) cachePct.style.textDecoration = nextPctDeco;
      if (cachePct.style.opacity !== nextPctOpacity) cachePct.style.opacity = nextPctOpacity;
      if (cachePct.style.color !== nextPctColor) cachePct.style.color = nextPctColor;
      if ((cachePct.style.fontWeight || '') !== nextPctWeight) cachePct.style.fontWeight = nextPctWeight;
    }
    if (cacheBadge) {
      if (cacheBadge.hidden !== nextBadgeHidden) cacheBadge.hidden = nextBadgeHidden;
      if (!nextBadgeHidden) {
        if (cacheBadge.textContent !== nextBadgeText) cacheBadge.textContent = nextBadgeText;
        if (cacheBadge.style.color !== nextBadgeColor) cacheBadge.style.color = nextBadgeColor;
      }
    }
    if (cacheRow && cacheRow.title !== nextCacheTitle) {
      cacheRow.title = nextCacheTitle;
    }

    // Capsule icon color priority: overflow/error/high occupancy -> cache expired -> cache warning -> normal
    const pct = d?.exceeded ? 100 : d?.percent;
    const errKind = d?.errorClassification?.kind || 'none';
    if (ctxIcon) {
      let nextCtxColor = '';
      if (d?.exceeded || (errKind !== 'none' && errKind !== 'canceled') || (pct != null && pct >= 90)) {
        nextCtxColor = 'var(--agc-danger)';
      } else if (iconTone === 'expired') {
        nextCtxColor = 'rgba(208, 122, 128, 0.88)';
      } else if (iconTone === 'warning' || (pct != null && pct >= 75)) {
        nextCtxColor = 'rgba(206, 168, 92, 0.88)';
      }
      if (ctxIcon.style.color !== nextCtxColor) ctxIcon.style.color = nextCtxColor;
    }

    // Minimalist Quota Popover
    const quotaRoot = el('quotaRoot');
    if (quotaRoot) {
      const groups = state.quotaGroups || [];
      let nextQuotaHtml = '';
      if (groups.length === 0) {
        nextQuotaHtml = `<div class="agc-q-empty">${escapeHtml(t.quotaNoData)}</div>`;
      } else {
        const hasMatched = Boolean(state.matchedGroup);
        for (const g of groups) {
          const isMatched = Boolean(state.matchedGroup && state.matchedGroup.rawName === g.rawName);
          nextQuotaHtml += `<div class="agc-q-group" data-active="${isMatched ? 'true' : 'false'}" data-dim="${hasMatched && !isMatched ? 'true' : 'false'}">`;
          nextQuotaHtml += `<div class="agc-q-title-row"><span class="agc-q-title">${escapeHtml(g.title)}</span>`;
          if (isMatched) {
            nextQuotaHtml += `<span class="agc-q-active"><span class="agc-q-active-dot"></span><span>${escapeHtml(t.quotaActiveBadge)}</span></span>`;
          }
          nextQuotaHtml += '</div><div class="agc-q-rows">';
          for (const b of g.buckets || []) {
            const label =
              b.window === 'weekly'
                ? t.quotaWeekly
                : b.window === '5h'
                  ? t.quotaFiveHours
                  : b.customLabel || b.window;
            const pctStr = b.remainingPct != null ? `${b.remainingPct}%` : '--%';
            const frac = b.remainingFraction != null ? Math.max(0, Math.min(1, Number(b.remainingFraction))) : 0;
            const widthPct = frac > 0 ? Math.max(4, Math.round(frac * 100)) : 0;
            const tone = quotaTone(b.remainingPct);
            const resetStr = formatResetShort(b.resetTime, t.quotaSoon, nowMs);
            const resetFull = formatResetDateTime(b.resetTime);
            const rowTip = t.quotaRowTip ? t.quotaRowTip(g.title, label, pctStr, resetFull) : '';
            const tipAttr = rowTip ? ` title="${escapeHtml(rowTip)}"` : '';
            const toneAttr = tone ? ` data-tone="${tone}"` : '';
            nextQuotaHtml += '<div class="agc-q-row">';
            nextQuotaHtml += `  <span class="agc-q-label"${tipAttr}>${escapeHtml(label)}</span>`;
            nextQuotaHtml += `  <div class="agc-q-bar"${tipAttr}><div class="agc-q-fill"${toneAttr} style="width:${widthPct}%"></div></div>`;
            nextQuotaHtml += `  <span class="agc-q-pct"${toneAttr}${tipAttr}>${pctStr}</span>`;
            nextQuotaHtml += `  <span class="agc-q-reset"${tipAttr}>${escapeHtml(resetStr)}</span>`;
            nextQuotaHtml += '</div>';
          }
          nextQuotaHtml += '</div></div>';
        }
      }
      if (lastQuotaRenderedHtml !== nextQuotaHtml) {
        quotaRoot.innerHTML = nextQuotaHtml;
        lastQuotaRenderedHtml = nextQuotaHtml;
      }
    }
    renderSpeedPill(nowMs);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderAlert(tone, message, tip = '') {
    const banner = el('alertBanner');
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.title = '';
      banner.replaceChildren();
      return;
    }
    banner.hidden = false;
    banner.setAttribute('data-tone', tone || 'neutral');
    banner.title = tip || String(message);
    banner.replaceChildren();

    const str = String(message);
    const cmdRe = /(^|[\s(（])(\/[a-z][a-z0-9-]*)(?=[\s.,;!?，。；！）)]|$)/g;
    let last = 0;
    let m;
    while ((m = cmdRe.exec(str)) !== null) {
      const start = m.index + m[1].length;
      if (start > last) {
        const s = document.createElement('span');
        s.textContent = str.slice(last, start);
        banner.appendChild(s);
      }
      const code = document.createElement('code');
      code.className = 'agc-cmd';
      code.textContent = m[2];
      banner.appendChild(code);
      last = start + m[2].length;
    }
    if (last < str.length) {
      const s = document.createElement('span');
      s.textContent = str.slice(last);
      banner.appendChild(s);
    }
  }

  function renderAll(nowMs = Date.now()) {
    if (state.disposed) return;
    applyStaticLabels();

    const t = getDict();
    const d = state.latest;
    const scan = state.scan;
    const errInfo = d?.errorClassification && d.errorClassification.kind !== 'none' ? d.errorClassification : null;
    const isHardError = Boolean(errInfo && errInfo.kind !== 'canceled');
    const exceeded = Boolean(d?.exceeded || errInfo?.kind === 'context_overflow');
    const pct = exceeded ? 100 : d?.percent ?? null;

    // 1. Inline Context Capsule (speed visible ONLY while generating in-flight)
    const pillCtx = el('pillCtx');
    if (pillCtx) {
      if (!state.convId) {
        pillCtx.textContent = '--%';
      } else if (isHardError) {
        pillCtx.textContent = errInfo.badgeText;
      } else if (pct != null) {
        const rounded = pct > 0 && pct < 1 ? 1 : Math.round(pct);
        pillCtx.textContent = `${rounded}%`;
      } else if (d?.estimate && d?.budget) {
        const estPct = Math.min(99, Math.max(1, Math.round((d.estimate / d.budget) * 100)));
        pillCtx.textContent = `~${estPct}%`;
      } else {
        pillCtx.textContent = '--%';
      }
    }

    const { sp, spTier, speedTip } = buildSpeedMeta(d?.speed, t, resolveLanguage());
    renderSpeedPill(nowMs);

    // 2. Refresh button busy state
    const btnRefresh = el('btnRefresh');
    if (btnRefresh) {
      btnRefresh.disabled = !state.convId || state.scanBusy;
      btnRefresh.setAttribute('data-busy', state.scanBusy ? 'true' : 'false');
    }

    // 3. Summary Row (clean, no extra status pill clutter)
    const heroPct = el('heroPct');
    const heroFrac = el('heroFrac');
    if (heroPct) {
      heroPct.style.color = '';
      if (!state.convId) {
        heroPct.textContent = t.usedPctFmt(0);
      } else if (exceeded) {
        heroPct.textContent = `100%+ · ${t.statusOverflow}`;
        heroPct.style.color = 'var(--agc-danger)';
      } else if (isHardError) {
        const base = pct != null ? t.usedPctFmt(Math.round(pct)) : t.statusIdle;
        heroPct.textContent = `${base} · ${errInfo.badgeText}`;
        heroPct.style.color = 'var(--agc-danger)';
      } else if (d?.actual != null && d?.budget) {
        const rawPct = (d.actual / d.budget) * 100;
        const shownPct = rawPct > 0 && rawPct < 1 ? 1 : Math.round(rawPct);
        heroPct.textContent = t.usedPctFmt(shownPct);
        if (rawPct >= 90) heroPct.style.color = 'var(--agc-danger)';
        else if (rawPct >= 75) heroPct.style.color = 'var(--agc-warn)';
      } else if (d?.estimate != null) {
        const estPct = d.budget ? Math.min(100, Math.round((d.estimate / d.budget) * 100)) : null;
        heroPct.textContent = estPct != null ? `~${t.usedPctFmt(estPct)}` : t.approxVal(fmtPreciseK(d.estimate));
      } else {
        heroPct.textContent = t.usedPctFmt(0);
      }
    }

    const setHeroFrac = (node, leftStr, rightStr) => {
      const sMain = document.createElement('span');
      sMain.className = 'agc-frac-main';
      sMain.textContent = leftStr;
      const sCap = document.createElement('span');
      sCap.className = 'agc-frac-cap';
      sCap.textContent = ` / ${rightStr}`;
      node.replaceChildren(sMain, sCap);
    };

    let heroTip = '';
    if (!state.convId) {
      heroTip = t.noActiveChat;
    } else if (exceeded) {
      heroTip = '';
    } else if (d?.actual != null && d?.budget) {
      const cached = d.cached || 0;
      const fresh = d.freshInput != null ? d.freshInput : Math.max(0, (d.input || 0) - cached);
      const out = d.output || 0;
      const rem = Math.max(0, d.budget - d.actual);
      heroTip =
        `${d.actual.toLocaleString()} / ${d.budget.toLocaleString()} tokens (${t.leftVal(fmtPreciseK(rem))})\n` +
        `${t.chipCache(fmtPreciseK(cached))} · ${t.chipInput(fmtPreciseK(fresh))} · ${t.chipOutput(fmtPreciseK(out))}`;
    } else if (d?.estimate != null) {
      heroTip = t.hintEst;
    } else {
      heroTip = t.waitingRequestData;
    }

    if (heroPct) heroPct.title = heroTip;

    if (heroFrac) {
      if (!state.convId) {
        setHeroFrac(heroFrac, '0', '256k');
      } else if (exceeded) {
        const lim = d?.serviceLimit || d?.budget;
        heroFrac.textContent = lim ? t.overLimit(fmtPreciseK(lim)) : t.overServerLimit;
      } else if (d?.actual != null && d?.budget) {
        setHeroFrac(heroFrac, fmtPreciseK(d.actual), fmtPreciseK(d.budget));
      } else if (d?.estimate != null) {
        if (d.budget) {
          setHeroFrac(heroFrac, t.approxVal(fmtPreciseK(d.estimate)), fmtPreciseK(d.budget));
        } else {
          heroFrac.textContent = t.tokensLocalEst;
        }
      } else {
        setHeroFrac(heroFrac, '0', fmtPreciseK(d?.budget || 256000));
      }
      heroFrac.title = heroTip;
    }

    // 4. 4px Progress Track (skip sub-pixel <0.8% confetti dots)
    const shares = scan?.shares || {};
    const occupiedPct =
      exceeded
        ? 100
        : d?.actual != null && d?.budget
          ? Math.min(100, (d.actual / d.budget) * 100)
          : d?.estimate != null && d?.budget
            ? Math.min(100, (d.estimate / d.budget) * 100)
            : 0;

    const track = el('track');
    if (track) track.title = heroTip;
    const segKeys = ['system', 'tools', 'assistant', 'thinking', 'user', 'summaries', 'attachment-total'];
    if (track) {
      const hasBreakdown = Boolean(scan && scan.totalWeight > 0);
      if (!state.convId || occupiedPct <= 0) {
        for (const k of segKeys) {
          const seg = track.querySelector(`[data-seg="${k}"]`);
          if (seg) {
            seg.style.width = '0%';
            seg.style.display = 'none';
          }
        }
      } else if (!hasBreakdown) {
        for (const k of segKeys) {
          const seg = track.querySelector(`[data-seg="${k}"]`);
          if (!seg) continue;
          if (k === 'system') {
            seg.style.display = 'block';
            seg.style.width = `${Math.max(1.5, occupiedPct).toFixed(2)}%`;
          } else {
            seg.style.width = '0%';
            seg.style.display = 'none';
          }
        }
      } else {
        let visibleRatioSum = 0;
        let maxKey = 'system';
        let maxRatio = -1;
        const visibleSet = new Set();
        for (const k of segKeys) {
          const r = shares[k]?.ratio || 0;
          if (r > maxRatio) {
            maxRatio = r;
            maxKey = k;
          }
          if (occupiedPct * r >= 0.8) {
            visibleSet.add(k);
            visibleRatioSum += r;
          }
        }
        if (visibleSet.size === 0 && maxRatio > 0) {
          visibleSet.add(maxKey);
          visibleRatioSum = maxRatio;
        }
        for (const k of segKeys) {
          const seg = track.querySelector(`[data-seg="${k}"]`);
          if (!seg) continue;
          if (visibleSet.has(k) && visibleRatioSum > 0) {
            const scaledW = occupiedPct * ((shares[k]?.ratio || 0) / visibleRatioSum);
            seg.style.display = 'block';
            seg.style.width = `${Math.max(1.2, scaledW).toFixed(2)}%`;
          } else {
            seg.style.width = '0%';
            seg.style.display = 'none';
          }
        }
      }
    }

    // 5. Conditional Alert Banner (hidden when healthy)
    const incomplete = Boolean(scan?.unknownFiles > 0);
    if (errInfo && errInfo.kind !== 'none') {
      renderAlert(errInfo.kind === 'canceled' ? 'neutral' : 'danger', errInfo.detail, errInfo.diagnostic || errInfo.detail);
    } else if (state.convId && pct != null && pct >= 90) {
      renderAlert('danger', t.alertHighOccupancy);
    } else if (state.convId && incomplete) {
      renderAlert('warn', t.alertUnknownFiles(scan.unknownFiles));
    } else if (state.convId && state.scanError && !scan) {
      renderAlert('warn', state.scanError);
    } else {
      renderAlert(null, '');
    }

    // 6. 7-Category 3-Column Tabular List
    const baseTokens = d?.actual ?? d?.estimate ?? 0;
    const fullCatNames = {
      system: t.catFullSystem,
      tools: t.catFullTools,
      assistant: t.catFullAssistant,
      thinking: t.catFullThinking,
      user: t.catFullUser,
      summaries: t.catFullSummaries,
      'attachment-total': t.catFullAttachment,
    };
    for (const k of segKeys) {
      const row = shadow.querySelector(`[data-row="${k}"]`);
      const valNode = shadow.querySelector(`[data-val="${k}"]`);
      const kNode = shadow.querySelector(`[data-k="${k}"]`);
      const share = shares[k] || { weight: 0, ratio: 0, text: '0%' };
      const rawEst = scan && baseTokens > 0 ? baseTokens * share.ratio : 0;
      const estTokens = Math.round(rawEst);

      if (valNode) {
        if (!scan) valNode.textContent = '—';
        else if (k === 'attachment-total' && incomplete) {
          valNode.textContent = share.weight > 0 ? `${share.text}+` : t.unknownShare;
        } else {
          valNode.textContent = share.text;
        }
      }
      if (kNode) {
        if (!scan) kNode.textContent = '—';
        else if (baseTokens <= 0) kNode.textContent = '0.0k';
        else if (share.weight > 0 && rawEst > 0 && estTokens < 50) kNode.textContent = '<0.1k';
        else kNode.textContent = fmtColK(estTokens);
      }
      if (row) {
        const isSubtle = Boolean(
          scan && (share.weight === 0 || share.ratio < 0.001) && !(k === 'attachment-total' && incomplete)
        );
        const isDom = Boolean(scan && !isSubtle && share.ratio >= 0.1);
        row.setAttribute('data-zero', isSubtle ? 'true' : 'false');
        row.setAttribute('data-tier', !scan ? 'act' : isDom ? 'dom' : isSubtle ? 'dim' : 'act');
        let tip = fullCatNames[k] || '';
        if (scan) {
          if (share.ratio > 0 && baseTokens > 0) {
            tip += ` · ${t.rowTipActual(Math.max(1, estTokens).toLocaleString(), share.text)}`;
          } else if (share.ratio > 0) {
            tip += ` · ${t.rowTipShare(share.text)}`;
          } else if (t.rowTipZero && !(k === 'attachment-total' && incomplete)) {
            tip += ` · ${t.rowTipZero}`;
          }
          if (k === 'attachment-total' && scan.attachments?.length) {
            const names = scan.attachments.slice(0, 4).map((a) => a.name).join(t.fileJoiner);
            const more = scan.attachments.length > 4 ? t.moreFiles(scan.attachments.length) : '';
            tip += `\n${t.filesLine ? t.filesLine(`${names}${more}`) : `${names}${more}`}`;
          }
        }
        row.title = tip;
        if (valNode) valNode.title = tip;
        if (kNode) kNode.title = tip;
        for (const child of row.children || []) {
          child.title = tip;
        }
      }
    }

    // 7. Minimalist 2-Line Generation Telemetry (below hairline divider)
    const valSpeed = el('valSpeed');
    const speedTier = el('speedTier');
    const valOut = el('valOut');
    const valTiming = el('valTiming');
    const valSteps = el('valSteps');

    if (valSpeed) {
      valSpeed.textContent = sp?.tps != null ? `${sp.tps} tok/s` : state.isTurnInFlight ? t.speedGenerating : '—';
      if (spTier) valSpeed.setAttribute('data-tier', spTier.level);
      else valSpeed.removeAttribute('data-tier');
      valSpeed.title = speedTip;
    }
    if (speedTier) {
      if (spTier) {
        speedTier.hidden = false;
        speedTier.textContent = spTier.label;
        speedTier.title = speedTip;
        speedTier.setAttribute('data-tier', spTier.level);
      } else {
        speedTier.hidden = true;
        speedTier.textContent = '';
        speedTier.title = '';
        speedTier.removeAttribute('data-tier');
      }
    }
    if (valOut) {
      if (sp?.outputTokens) {
        const outFull = t.outCompact(fmtK(sp.outputTokens));
        const spIdx = outFull.lastIndexOf(' ');
        if (spIdx > 0) {
          const sLbl = document.createElement('span');
          sLbl.textContent = outFull.slice(0, spIdx + 1);
          const sVal = document.createElement('span');
          sVal.className = 'agc-out-val';
          sVal.textContent = outFull.slice(spIdx + 1);
          valOut.replaceChildren(sLbl, sVal);
        } else {
          valOut.textContent = outFull;
        }
      } else {
        valOut.textContent = '—';
      }
      if (sp?.outputTokens) {
        const thk = sp.thinkingTokens || 0;
        const rep = sp.responseTokens != null ? sp.responseTokens : Math.max(0, sp.outputTokens - thk);
        valOut.title = t.outTitle(
          sp.outputTokens.toLocaleString(),
          rep.toLocaleString(),
          thk > 0 ? thk.toLocaleString() : ''
        );
      } else {
        valOut.title = '';
      }
    }
    if (valTiming) {
      if (sp?.ttft != null || sp?.duration != null) {
        valTiming.textContent = t.timingCompact(fmtSec(sp?.ttft), fmtSec(sp?.duration));
        valTiming.title = t.timingTip(
          sp?.ttft != null ? fmtSec(sp.ttft) : '',
          sp?.streamingSec != null ? fmtSec(sp.streamingSec) : '',
          sp?.duration != null ? fmtSec(sp.duration) : ''
        );
      } else {
        valTiming.textContent = t.timingCompact('—', '—');
        valTiming.title = '';
      }
    }
    if (valSteps) {
      if (scan) {
        const shown = scan.activeSteps ?? scan.steps;
        valSteps.textContent = t.stepsCount(shown);
        const stepTip = scan.compacted
          ? t.stepsTitleCompacted(shown, scan.steps, scan.userMessages, scan.assistantMessages)
          : t.stepsTitleNormal(shown, scan.userMessages, scan.assistantMessages);
        const tsStr = scan.scannedAt
          ? `\n${t.updatedAt(new Date(scan.scannedAt).toLocaleTimeString([], { hour12: false }))}`
          : '';
        valSteps.title = `${stepTip}${tsStr}`;
      } else if (state.convId && state.scanBusy) {
        valSteps.textContent = t.scanning;
        valSteps.title = '';
      } else {
        valSteps.textContent = '—';
        valSteps.title = '';
      }
    }

    syncModelQuotaPills();
    renderCacheAndCountdowns(nowMs);
    adjustLayout();
    syncPopoverVisibility();
  }

  function ensureDocked() {
    if (state.disposed) return false;
    ensureHostStyles();
    if (!String(host.style?.cssText || '').includes('margin-left')) {
      host.style.cssText = HOST_INLINE_STYLE;
    }
    const footerLeft = findFooterLeft();
    if (!footerLeft) return false;
    const lastChild =
      footerLeft.lastElementChild !== undefined
        ? footerLeft.lastElementChild
        : footerLeft.children?.[footerLeft.children.length - 1];
    if (host.parentElement !== footerLeft || lastChild !== host) {
      footerLeft.appendChild(host);
    }
    if (observedFooterLeft !== footerLeft) {
      modelObserver?.disconnect();
      resizeObserver?.disconnect();
      observedFooterLeft = footerLeft;

      if (typeof MutationObserver !== 'undefined') {
        modelObserver = new MutationObserver((mutations) => {
          if (mutations.every((m) => host.contains(m.target))) return;
          syncModelQuotaPills();
          renderCacheAndCountdowns();
          scheduleAdjustLayout();
        });
        modelObserver.observe(footerLeft, { subtree: true, characterData: true, childList: true });
      }
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => scheduleAdjustLayout());
        if (footerLeft.parentElement) resizeObserver.observe(footerLeft.parentElement);
        resizeObserver.observe(footerLeft);
      }
      syncModelQuotaPills();
      adjustLayout();
    }
    return true;
  }

  function scheduleEnsureDocked() {
    if (dockPending || state.disposed) return;
    dockPending = true;
    const flush = () => {
      dockPending = false;
      if (!state.disposed) ensureDocked();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else if (typeof queueMicrotask === 'function') queueMicrotask(flush);
    else flush();
  }

  // Event wiring inside Shadow DOM
  const grpCtx = el('grpCtx');
  const grpQuota = el('grpQuota');
  grpCtx?.addEventListener('mouseenter', () => openPopover('ctx', false));
  grpCtx?.addEventListener('mouseleave', () => scheduleClosePopover('ctx'));
  grpQuota?.addEventListener('mouseenter', () => openPopover('quota', false));
  grpQuota?.addEventListener('mouseleave', () => scheduleClosePopover('quota'));

  el('btnCtx')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover('ctx', true);
  });
  el('btnQuota')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover('quota', true);
  });
  el('btnRefresh')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.convId || state.scanBusy) return;
    state.pendingForceScan = true;
    state.scanBusy = true;
    renderAll();
  });
  el('btnLang')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const detected = detectHostLocale();
    const active = resolveLanguage();
    const idx = LANG_CYCLE.indexOf(active);
    const nextLang = LANG_CYCLE[(idx + 1) % LANG_CYCLE.length];
    const nextMode = nextLang === detected ? 'auto' : nextLang;
    state.prefs = { ...state.prefs, langMode: nextMode };
    state.pendingPrefsPatch = { ...(state.pendingPrefsPatch || {}), langMode: nextMode };
    renderAll();
  });
  el('btnTheme')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const cur = state.prefs?.themeMode || 'auto';
    const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
    state.prefs = { ...state.prefs, themeMode: next };
    state.pendingPrefsPatch = { ...(state.pendingPrefsPatch || {}), themeMode: next };
    renderAll();
  });

  const onOutsideClick = (e) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!path.includes(host)) {
      closeAllPopovers();
    }
  };
  const onEscapeKey = (e) => {
    if (e.key === 'Escape' && state.openPop) {
      closeAllPopovers();
    }
  };
  const onWindowResize = () => {
    adjustLayout();
    if (state.openPop) positionPopover(state.openPop);
  };

  document.addEventListener('click', onOutsideClick);
  document.addEventListener('keydown', onEscapeKey);
  window.addEventListener?.('resize', onWindowResize);

  if (typeof MutationObserver !== 'undefined') {
    if (document.body) {
      bodyObserver = new MutationObserver(() => {
        const activeLeft = findFooterLeft();
        if (!host.isConnected || (activeLeft && host.parentElement !== activeLeft)) {
          scheduleEnsureDocked();
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    themeAttrObserver = new MutationObserver(() => {
      applyTheme();
      if ((!state.prefs?.langMode || state.prefs.langMode === 'auto') && host.getAttribute('lang') !== resolveLanguage()) {
        renderAll();
      }
    });
    if (document.documentElement) {
      themeAttrObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'lang'],
      });
    }
    if (document.body) {
      themeAttrObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'lang'],
      });
    }
  }

  const localClockTimer = setInterval(() => {
    if (state.disposed) return;
    ensureDocked();
    renderCacheAndCountdowns();
  }, LOCAL_CLOCK_INTERVAL_MS);

  ensureDocked();
  renderAll();

  globalThis.__agyCapsule = {
    version: CAPSULE_VERSION,
    pullClientState(callerTs) {
      if (state.disposed) return null;
      const ts = Number(callerTs || 0);
      if (ts > 0 && state.ownerTs > 0 && ts < state.ownerTs) {
        return 'superseded';
      }
      if (ts > state.ownerTs) {
        state.ownerTs = ts;
      }
      ensureDocked();
      const convId = getRouteConvId();
      if (convId !== state.convId) {
        state.convId = convId;
        state.pendingForceScan = false;
        state.wasTurnInFlight = false;
        state.speedCoolUntilMs = 0;
        clearSpeedCoolTimer();
        closeAllPopovers();
      }
      const forceScan = state.pendingForceScan;
      const prefsPatch = state.pendingPrefsPatch;
      state.pendingForceScan = false;
      state.pendingPrefsPatch = null;
      return {
        v: CAPSULE_VERSION,
        hash: globalThis.__AGY_CAPSULE_BUNDLE_HASH || '',
        convId,
        lang: resolveLanguage(),
        wantScan: state.openPop === 'ctx',
        forceScan,
        prefsPatch,
      };
    },
    applyServerState(payload) {
      if (state.disposed || !payload) return false;
      ensureDocked();
      const nextConvId = payload.convId || '';
      const convChanged = nextConvId !== state.convId;
      const prevLastStepMs = !convChanged ? state.latest?.lastStepEpochMs || 0 : 0;
      if (convChanged) {
        state.wasTurnInFlight = false;
        state.speedCoolUntilMs = 0;
        clearSpeedCoolTimer();
      }
      state.convId = nextConvId;
      if (payload.prefs && typeof payload.prefs === 'object') {
        state.prefs = { ...state.prefs, ...payload.prefs, ...(state.pendingPrefsPatch || {}) };
      }
      if (Array.isArray(payload.quotaGroups)) {
        state.quotaGroups = payload.quotaGroups;
      }
      state.latest = payload.latest || null;
      state.scan = payload.scan || null;
      state.scanBusy = Boolean(payload.scanBusy || state.pendingForceScan);
      state.scanError = payload.scanError || '';
      const nextInFlight = Boolean(payload.isTurnInFlight);
      state.isTurnInFlight = nextInFlight;

      const nowMs = Date.now();
      if (nextInFlight) {
        state.wasTurnInFlight = true;
        state.speedCoolUntilMs = 0;
        clearSpeedCoolTimer();
      } else {
        const stepMs = state.latest?.lastStepEpochMs || 0;
        if (state.wasTurnInFlight) {
          state.wasTurnInFlight = false;
          state.speedCoolUntilMs = nowMs + SPEED_COOL_DELAY_MS;
          scheduleSpeedCoolTimer(nowMs);
        } else if (stepMs > 0 && stepMs !== prevLastStepMs && nowMs >= stepMs && nowMs - stepMs < SPEED_COOL_DELAY_MS) {
          state.speedCoolUntilMs = stepMs + SPEED_COOL_DELAY_MS;
          scheduleSpeedCoolTimer(nowMs);
        } else if (state.speedCoolUntilMs > 0 && nowMs >= state.speedCoolUntilMs) {
          state.speedCoolUntilMs = 0;
          clearSpeedCoolTimer();
        }
      }

      renderAll(nowMs);
      return true;
    },
    tickClockForTest(nowMs) {
      renderCacheAndCountdowns(nowMs);
    },
    adjustLayoutForTest() {
      adjustLayout();
      return el('strip')?.className || '';
    },
    snapshotForTest() {
      return {
        docked: Boolean(host.parentElement),
        convId: state.convId,
        lang: resolveLanguage(),
        theme: resolveTheme(),
        openPop: state.openPop,
        pinnedPop: state.pinnedPop,
        pillCtx: el('pillCtx')?.textContent,
        pillSpeedHidden: Boolean(el('pillSpeed')?.hidden),
        pillSpeedState: el('pillSpeed')?.getAttribute('data-state') || '',
        pillSpeed: el('pillSpeedVal')?.textContent,
        pill5h: el('pill5h')?.textContent,
        pillWk: el('pillWk')?.textContent,
        cachePct: el('cachePct')?.textContent,
        cacheBadge: el('cacheBadge')?.hidden ? '' : el('cacheBadge')?.textContent,
        cacheDeco: el('cachePct')?.style.textDecoration || '',
        heroPct: el('heroPct')?.textContent,
        heroFrac: el('heroFrac')?.textContent,
        valSpeed: el('valSpeed')?.textContent,
        speedTier: el('speedTier')?.hidden ? '' : el('speedTier')?.textContent,
        valTiming: el('valTiming')?.textContent,
        valOut: el('valOut')?.textContent,
        valSteps: el('valSteps')?.textContent,
        stripClass: el('strip')?.className || '',
      };
    },
    dispose() {
      state.disposed = true;
      clearHoverTimer();
      clearSpeedCoolTimer();
      clearInterval(localClockTimer);
      if (layoutRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(layoutRafId);
        layoutRafId = 0;
      }
      try { modelObserver?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { bodyObserver?.disconnect(); } catch {}
      try { themeAttrObserver?.disconnect(); } catch {}
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onEscapeKey);
      window.removeEventListener?.('resize', onWindowResize);
      try { document.getElementById?.('agy-capsule-host-squeeze')?.remove?.(); } catch {}
      try { host.remove(); } catch {}
      delete globalThis.__agyCapsule;
    },
  };
})();
