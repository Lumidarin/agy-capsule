// Deck injector: mounts a compact metrics strip into the Antigravity composer
// footer (next to the model selector) via the local DevTools (CDP) endpoint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createPresentation, getPresentationScript } from './ui.mjs';
import { DECK_SKIN_CSS } from './ui_skins.mjs';

const {
  escapeHtml, appearance, formatReset, cacheView,
  quotaColor, makeRingSvg, formatGroupTitle, formatBucketLabel, activeGroupColor, contextBreakdown,
} = createPresentation();

const INTERVAL_MS = 1000;
const INSTANCE_TS = Date.now();
const PORT_FILE =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');

function detectHostTheme() {
  try {
    const body = document.body;
    const doc = document.documentElement;
    const hasCls = (el, ...names) => names.some(n => el?.classList?.contains(n));
    if (hasCls(body, 'theme-light', 'light', 'vscode-light') || hasCls(doc, 'theme-light', 'light', 'vscode-light')) return 'light';
    if (hasCls(body, 'theme-dark', 'dark', 'vscode-dark') || hasCls(doc, 'theme-dark', 'dark', 'vscode-dark')) return 'dark';
    const parseLum = (str) => {
      if (!str || typeof str !== 'string') return null;
      const s = str.trim();
      if (!s || /^transparent$/i.test(s)) return null;
      const hex = s.replace(/^#/, '');
      if (/^[0-9a-fA-F]{3,4}$/.test(hex)) {
        if (hex.length === 4 && parseInt(hex[3] + hex[3], 16) === 0) return null;
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      }
      if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
        if (hex.length === 8 && parseInt(hex.slice(6, 8), 16) === 0) return null;
        const n = parseInt(hex.slice(0, 6), 16);
        return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      }
      const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
      if (!rgb) return null;
      if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null;
      return (0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3])) / 255;
    };
    if (typeof getComputedStyle === 'function') {
      for (const el of [body, doc]) {
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.colorScheme === 'light') return 'light';
        if (cs.colorScheme === 'dark') return 'dark';
        for (const candidate of [cs.getPropertyValue('--background'), cs.backgroundColor]) {
          const lum = parseLum(candidate);
          if (lum !== null) return lum >= 0.5 ? 'light' : 'dark';
        }
      }
    }
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch {}
  return 'dark';
}

// Self-contained function executed inside the Antigravity renderer page.
function pageMount(d) {
  if (window.__deckOwnerTs && d.instanceTs && d.instanceTs < window.__deckOwnerTs) {
    return 'superseded';
  }
  if (d.instanceTs) {
    window.__deckOwnerTs = d.instanceTs;
  }
  const footerLeft = document.querySelector('.agy-composer-footer > div:first-child');
  if (!footerLeft) {
    window.__agyCapsuleCleanup?.();
    return 'no-footer';
  }
  const presentation = globalThis.__agyCapsulePresentation;

  const release = (node) => {
    if (!node) return;
    document.removeEventListener('click', node._onOutsideClick);
    document.removeEventListener('keydown', node._onEscape);
    if (node._onResize) window.removeEventListener('resize', node._onResize);
    node._modelObserver?.disconnect();
    node._resizeObserver?.disconnect();
    if (node._layoutRaf) cancelAnimationFrame(node._layoutRaf);
    node._layoutRaf = 0;
    node._turboTarget?.removeAttribute('data-deck-turbo-collapsed');
    const classes = ['dk-fl-squeezed', 'dk-model-squeezed', 'dk-model-squeezed-hard', 'dk-squeeze-box', 'dk-squeeze-item'];
    for (const footer of new Set([node._observedFooterLeft, document.querySelector('.agy-composer-footer > div:first-child')])) {
      if (!footer) continue;
      for (const element of [footer, ...footer.querySelectorAll(classes.map(c => '.' + c).join(','))]) element.classList.remove(...classes);
    }
  };
  // A late legacy injector may recreate its light-DOM strip after migration.
  // Remove it on every pass, not only when initializing the shadow host.
  const legacy = document.getElementById('deck-metrics-strip');
  if (legacy) { release(legacy); legacy.remove(); }
  let host = document.getElementById('agy-capsule-host');
  let root = host?.shadowRoot?.getElementById('deck-metrics-strip');
  if (!root) {
    window.__agyCapsuleCleanup?.();
    host?.remove();
    host = document.createElement('div');
    host.id = 'agy-capsule-host';
    host.style.display = 'contents';
    const shadow = host.attachShadow({ mode: 'open' });
    root = document.createElement('div');
    root.id = 'deck-metrics-strip';
    shadow.appendChild(root);
  }

  // Upgrade or initialize DOM structure in-place
  if (root.getAttribute('data-deck-ver') !== '109') {
    release(root);
    root._pinnedGroup = null;
    root.removeAttribute('data-pinned');
    root.setAttribute('data-deck-ver', '109');
    root._speedActivity = null;
    root._motionPrev = null;
    root.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'flex-shrink: 0',
      'gap: 2px',
      'margin-left: 6px',
      'margin-right: 6px',
      'font-size: 12px',
      // Match the promo's Source Han faces, with local-only cross-platform fallbacks.
      'font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft JhengHei UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang TC", "PingFang SC", system-ui, Arial, sans-serif',
      'font-weight: 400',
      'font-variation-settings: normal',
      'font-variant-ligatures: normal',
      'line-height: normal',
      'user-select: none',
      'position: relative',
      '-webkit-font-smoothing: antialiased',
    ].join(';');

    root.innerHTML = `
      <style>
        #deck-metrics-strip, #deck-metrics-strip * { box-sizing: border-box; }
        ${DECK_SKIN_CSS}
        #deck-metrics-strip .dk-strip-sep { width: 1px; height: 9px; background: var(--agc-hairline-v); flex-shrink: 0; margin: 0 1px; }
        #deck-metrics-strip .dk-strip-sep[hidden],
        #deck-metrics-strip.dk-hide-ctx .dk-strip-sep-quota,
        #deck-metrics-strip.dk-hide-quota .dk-strip-sep-quota { display: none; }
        #deck-metrics-strip .dk-grp {
          display: inline-flex;
          align-items: center;
          /* Popovers are placed by JS relative to their group: context and
             quota start at the strip's left edge but always reach their own
             capsule's right edge; the error panel right-aligns to its capsule. */
          position: relative;
        }
        #deck-metrics-strip .dk-pill {
          font: inherit;
          font-size: 12px;
          line-height: 1.3;
          color: var(--agc-muted);
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2.5px 5px;
          border-radius: 5.5px;
          cursor: default;
          position: relative;
          background: transparent;
          border: none;
          white-space: nowrap;
          transition: background 0.14s ease, color 0.14s ease;
        }
        #deck-metrics-strip .dk-grp:hover .dk-pill {
          background: var(--agc-pill-hover);
          color: var(--agc-fg-strong);
        }
        #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-pill {
          background: var(--agc-pill-active);
          color: var(--agc-fg-strong);
          box-shadow: inset 0 0 0 0.5px var(--agc-card-border);
        }
        #deck-metrics-strip .dk-grp:hover .dk-val,
        #deck-metrics-strip .dk-grp:hover .dk-svg,
        #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-val,
        #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-svg {
          color: var(--agc-fg-strong);
        }
        #deck-metrics-strip .dk-pill-quota {
          gap: 7px;
        }
        #deck-metrics-strip .dk-q-pair[hidden],
        #deck-metrics-strip .dk-grp[hidden] { display: none; }
        #deck-metrics-strip .dk-q-pair[data-tone="warn"],
        #deck-metrics-strip .dk-q-pair[data-tone="warn"] .dk-val { color: var(--agc-warn); }
        #deck-metrics-strip .dk-q-pair[data-tone="danger"],
        #deck-metrics-strip .dk-q-pair[data-tone="danger"] .dk-val { color: var(--agc-danger); }
        #deck-metrics-strip [data-el="grpError"] .dk-pill,
        #deck-metrics-strip [data-el="grpError"] .dk-val,
        #deck-metrics-strip [data-el="grpError"] .dk-svg { color: var(--agc-danger); }
        #deck-metrics-strip .dk-error-pop { width: 240px; }
        #deck-metrics-strip .dk-error-head { display: flex; align-items: center; gap: 6px; }
        #deck-metrics-strip .dk-error-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--agc-danger); box-shadow: inset 0 0.5px 0 var(--agc-dot-rim); flex-shrink: 0; }
        #deck-metrics-strip .dk-error-heading { font-size: 12px; font-weight: 600; line-height: 1.35; color: var(--agc-danger); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #deck-metrics-strip .dk-error-detail { font-size: 11px; color: var(--agc-fg); line-height: 1.45; }
        #deck-metrics-strip .dk-error-diagnostic { margin-top: var(--agy-section-gap, 9px); padding-top: var(--agy-section-gap, 9px); border-top: 0.5px solid var(--agc-divider); white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.4; color: var(--agc-muted); }
        #deck-metrics-strip .dk-error-diagnostic:empty { display: none; }
        #deck-metrics-strip.dk-hide-error-label [data-el="grpError"] .dk-val,
        #deck-metrics-strip.dk-hide-ctx [data-el="grpCtx"] { display: none; }
        #deck-metrics-strip[data-context-tone="warning"] [data-k="pillCtx"] { color: var(--agc-warn) !important; }
        #deck-metrics-strip[data-context-tone="error"] [data-k="pillCtx"] { color: var(--agc-danger) !important; }
        #deck-metrics-strip .dk-speed { padding-left: 2px; font-variant-numeric: tabular-nums; font-weight: 500; }
        #deck-metrics-strip .dk-speed-dot { display: none; }
        #deck-metrics-strip .dk-speed[data-motion] { display: inline-flex; align-items: center; gap: 4px; transition: color .35s ease; }
        #deck-metrics-strip .dk-speed[data-motion] .dk-speed-dot { display: inline-block; width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
        #deck-metrics-strip .dk-speed[data-tier="green"] { color: var(--agc-good); }
        #deck-metrics-strip .dk-speed[data-tier="yellow"] { color: var(--agc-warn); }
        #deck-metrics-strip .dk-speed[data-tier="red"] { color: var(--agc-danger); }
        #deck-metrics-strip .dk-speed[data-motion="idle"] { color: var(--agc-muted); }
        #deck-metrics-strip .dk-pill:hover .dk-speed[data-motion="idle"],
        #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-speed[data-motion="idle"] { color: var(--agc-fg-strong); }
        #deck-metrics-strip .dk-speed[data-motion="active"] .dk-speed-dot { animation: dk-speed-breathe 1.2s ease-in-out infinite; }
        #deck-metrics-strip .dk-speed[data-motion="recent"] .dk-speed-dot { opacity: .92; }
        #deck-metrics-strip .dk-speed[data-motion="idle"] .dk-speed-dot { opacity: .48; }
        /* Same motion language as the settings previews: colors ease over .18s. */
        #deck-metrics-strip [data-k="pillCtx"], #deck-metrics-strip [data-el="ctxIconSvg"],
        #deck-metrics-strip .dk-cache-pct, #deck-metrics-strip .dk-cache-k { transition: color .18s ease, opacity .18s ease; }
        @keyframes dk-speed-breathe { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.78); } }
        @keyframes dk-pop-in { from { opacity: 0; transform: translateY(3px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @media (prefers-reduced-motion: reduce) {
          #deck-metrics-strip .dk-speed[data-motion="active"] .dk-speed-dot { animation: none; }
          #deck-metrics-strip .dk-speed[data-motion] { transition: none; }
          #deck-metrics-strip [data-k="pillCtx"], #deck-metrics-strip [data-el="ctxIconSvg"],
          #deck-metrics-strip .dk-cache-pct, #deck-metrics-strip .dk-cache-k, #deck-metrics-strip .dk-q-group, #deck-metrics-strip .dk-q-active { transition: none; }
        }
        #deck-metrics-strip .dk-speed[hidden],
        #deck-metrics-strip.dk-hide-speed .dk-speed { display: none; }
        #deck-metrics-strip .dk-generation { margin-top: var(--agy-section-gap, 9px); padding-top: var(--agy-section-gap, 9px); border-top: 0.5px solid var(--agc-divider); font-variant-numeric: tabular-nums; }
        #deck-metrics-strip .generation-row[hidden], #deck-metrics-strip [data-generation-group][hidden] { display: none; }
        #deck-metrics-strip.dk-hide-wk [data-el="pairWk"],
        #deck-metrics-strip.dk-hide-5h [data-el="pair5h"] { display: none; }
        #deck-metrics-strip.dk-hide-wk .dk-pill-quota,
        #deck-metrics-strip.dk-hide-5h .dk-pill-quota { gap: 0; }
        #deck-metrics-strip.dk-hide-qval [data-el="grpQuota"] .dk-val { display: none; }
        #deck-metrics-strip.dk-hide-qval [data-el="grpQuota"] .dk-q-pair { gap: 0; }
        #deck-metrics-strip.dk-hide-cval [data-el="grpCtx"] .dk-val { display: none; }
        #deck-metrics-strip.dk-hide-cval [data-el="grpCtx"] .dk-pill { gap: 0; }
        #deck-metrics-strip.dk-hide-quota [data-el="grpQuota"] { display: none; }
        #deck-metrics-strip.dk-hide-all { display: none !important; }
        #deck-metrics-strip .dk-q-pair {
          display: inline-flex;
          align-items: center;
          gap: 3.5px;
          transition: color 0.14s ease;
        }
        #deck-metrics-strip .dk-svg {
          width: 12px;
          height: 12px;
          color: var(--agc-muted);
          flex-shrink: 0;
          transition: color 0.14s ease;
        }
        #deck-metrics-strip .dk-val {
          font-weight: 500;
          color: var(--agc-fg);
          font-variant-numeric: tabular-nums;
          transition: color 0.14s ease;
        }
        #deck-metrics-strip .dk-pop {
          display: none;
          position: absolute;
          bottom: calc(100% + 7px);
          left: 0;
          background: linear-gradient(180deg, var(--agc-card-top) 0%, var(--agc-card-bg) 100%);
          backdrop-filter: blur(40px) saturate(185%);
          -webkit-backdrop-filter: blur(40px) saturate(185%);
          border: none;
          border-radius: 11px;
          padding: var(--agy-pad-y, 10px) var(--agy-pad-x, 12px);
          max-width: var(--dk-pop-max-width, calc(100vw - 16px));
          overflow-wrap: anywhere;
          box-shadow: inset 0 0.5px 0 var(--agc-card-rim), 0 0 0 0.5px var(--agc-card-border), var(--agc-card-shadow);
          z-index: 999999;
          color: var(--agc-muted);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          line-height: 1.35;
          pointer-events: none;
          transform-origin: 18px 100%;
        }
        #deck-metrics-strip .dk-pop::after {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          bottom: -10px;
          height: 10px;
          background: transparent;
          pointer-events: auto;
        }
        #deck-metrics-strip .dk-grp:hover .dk-pop,
        #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-pop {
          display: block;
          pointer-events: auto;
        }
        @media (prefers-reduced-motion: no-preference) {
          #deck-metrics-strip .dk-grp:hover .dk-pop,
          #deck-metrics-strip .dk-grp[data-pinned="true"] .dk-pop { animation: dk-pop-in 0.13s cubic-bezier(0.22, 1, 0.36, 1); }
        }
        #deck-metrics-strip[data-pinned] .dk-grp:not([data-pinned="true"]):hover .dk-pop,
        #deck-metrics-strip .dk-grp[data-dismissed="true"] .dk-pop { display: none; }
        /* Context Popover */
        #deck-metrics-strip .dk-ctx-pop { width: 228px; }
        #deck-metrics-strip .dk-ctx-pop:where(:has(> .dk-panel-content > .dk-foot-grid > [data-generation-block]:not([hidden]))) { width: 232px; }
        #deck-metrics-strip[data-context-layout="columns"][data-column-percent="true"] .dk-ctx-pop { width: 236px; }
        #deck-metrics-strip .dk-ctx-pop > .dk-panel-content { display: flex; flex-direction: column; }
        #deck-metrics-strip[data-request-position="top"] .dk-ctx-pop > .dk-panel-content > .dk-foot-grid { order: -2; }
        #deck-metrics-strip[data-request-position="top"] .dk-ctx-pop > .dk-panel-content > .dk-divider { order: -1; }
        #deck-metrics-strip .dk-head-row {
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          align-items: baseline;
          column-gap: 10px;
          row-gap: 2px;
          margin-bottom: var(--agy-section-gap, 9px);
        }
        #deck-metrics-strip .dk-used-pct {
          font-size: 12px;
          font-weight: 400;
          line-height: 1.35;
          color: var(--agc-muted);
          white-space: nowrap;
        }
        #deck-metrics-strip .dk-used-pct > [data-k="usedPctText"] {
          font-size: 12px;
          font-weight: 600;
          color: var(--agc-fg-strong);
        }
        #deck-metrics-strip .dk-used-frac {
          font-size: 12px;
          font-weight: 500;
          line-height: 1.35;
          color: var(--agc-fg-strong);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        #deck-metrics-strip .dk-track {
          position: relative;
          width: 100%;
          height: 4px;
          background: var(--agc-track);
          box-shadow: inset 0 0 0 0.5px var(--agc-track-ring);
          border-radius: 99px;
          display: flex;
          gap: 1px;
          overflow: hidden;
          margin-bottom: var(--agy-section-gap, 9px);
        }
        #deck-metrics-strip .dk-seg {
          height: 100%;
          border-radius: 0;
          background-image: linear-gradient(180deg, var(--agc-seg-sheen) 0%, transparent 72%);
          transition: width 0.25s ease, opacity 0.14s ease, filter 0.14s ease;
          cursor: pointer;
        }
        #deck-metrics-strip .dk-seg[data-cat="turn0"], #deck-metrics-strip .dk-item-row[data-cat="turn0"] .dk-dot { background-color: var(--agc-c-turn0); }
        #deck-metrics-strip .dk-seg[data-cat="read"], #deck-metrics-strip .dk-item-row[data-cat="read"] .dk-dot { background-color: var(--agc-c-read); }
        #deck-metrics-strip .dk-seg[data-cat="think"], #deck-metrics-strip .dk-item-row[data-cat="think"] .dk-dot { background-color: var(--agc-c-think); }
        #deck-metrics-strip .dk-seg[data-cat="out"], #deck-metrics-strip .dk-item-row[data-cat="out"] .dk-dot { background-color: var(--agc-c-out); }
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat] .dk-seg { opacity: 0.28; }
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat] .dk-item-row { opacity: 0.36; }
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="turn0"] .dk-seg[data-cat="turn0"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="read"] .dk-seg[data-cat="read"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="think"] .dk-seg[data-cat="think"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="out"] .dk-seg[data-cat="out"] { opacity: 1; filter: brightness(1.16); }
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="turn0"] .dk-item-row[data-cat="turn0"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="read"] .dk-item-row[data-cat="read"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="think"] .dk-item-row[data-cat="think"],
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="out"] .dk-item-row[data-cat="out"] { opacity: 1; background: var(--agc-pill-hover); }
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="turn0"] .dk-item-row[data-cat="turn0"] .dk-item-label,
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="read"] .dk-item-row[data-cat="read"] .dk-item-label,
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="think"] .dk-item-row[data-cat="think"] .dk-item-label,
        #deck-metrics-strip .dk-ctx-pop[data-hover-cat="out"] .dk-item-row[data-cat="out"] .dk-item-label { color: var(--agc-fg-strong); }
        #deck-metrics-strip .dk-list,
        #deck-metrics-strip .turn-bar-list {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          align-items: start;
          gap: 4px;
        }
        #deck-metrics-strip .turn-bar-list {
          grid-template-columns: minmax(calc((100% - 12px) / 4), max-content) minmax(0, 1fr) calc((100% - 12px) / 4) calc((100% - 12px) / 4);
        }
        #deck-metrics-strip .dk-item-row,
        #deck-metrics-strip .turn-bar-item {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          column-gap: 5px;
          row-gap: 2px;
          min-width: 0;
          border-radius: 4px;
          transition: opacity 0.14s ease, background 0.14s ease;
        }
        #deck-metrics-strip .dk-item-row[data-zero="true"] { opacity: 0.44; }
        #deck-metrics-strip .dk-item-row[data-zero="true"]:hover { opacity: 0.92; }
        #deck-metrics-strip .dk-item-body {
          display: flex;
          flex-direction: column;
          row-gap: 2px;
          column-gap: 10px;
          min-width: 0;
        }
        #deck-metrics-strip .dk-item-label,
        #deck-metrics-strip .turn-bar-label,
        #deck-metrics-strip .turn-bar-short {
          color: var(--agc-muted);
          font-size: 11px;
          line-height: 1.35;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 0.14s ease;
        }
        #deck-metrics-strip .turn-bar-item[data-turn-row="requests"] {
          container-type: inline-size;
        }
        #deck-metrics-strip .turn-bar-short {
          display: none;
        }
        @container (max-width: 39px) {
          #deck-metrics-strip .turn-bar-item[data-turn-row="requests"] .turn-bar-label {
            display: none;
          }
          #deck-metrics-strip .turn-bar-item[data-turn-row="requests"] .turn-bar-short {
            display: block;
          }
        }
        #deck-metrics-strip .dk-item-row > .dk-dot,
        #deck-metrics-strip .turn-bar-line {
          grid-row: 1 / span 2;
          align-self: stretch;
          width: 2.5px;
          margin: 2px 0;
          border-radius: 99px;
          flex-shrink: 0;
        }
        #deck-metrics-strip .turn-bar-line {
          background: var(--agc-turn-line, color-mix(in srgb, var(--agc-muted) 50%, transparent));
        }
        #deck-metrics-strip .dk-item-row > .dk-dot { grid-row: 1; }
        #deck-metrics-strip .dk-item-k,
        #deck-metrics-strip .dk-item-pct,
        #deck-metrics-strip .turn-bar-val {
          grid-column: 2;
          color: var(--agc-fg-strong);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
          font-size: 11px;
          font-weight: 500;
          line-height: 1.35;
        }
        #deck-metrics-strip .dk-item-pct { color: var(--agc-muted); font-weight: 400; }
        #deck-metrics-strip .dk-divider { height: 0.5px; background: var(--agc-divider); margin: var(--agy-section-gap, 9px) 0; }
        #deck-metrics-strip .dk-foot-grid { display: flex; justify-content: space-between; align-items: flex-start; column-gap: 6px; font-variant-numeric: tabular-nums; }
        #deck-metrics-strip .dk-foot-gen-wrap { display: contents; }
        #deck-metrics-strip .dk-foot-gen-wrap[hidden] { display: none; }
        #deck-metrics-strip .dk-foot-col { flex: 0 1 auto; min-width: 0; }
        #deck-metrics-strip .dk-foot-top { height: 16px; min-width: 0; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
        #deck-metrics-strip .dk-foot-top-right, #deck-metrics-strip .dk-foot-sub-right { justify-content: flex-end; }
        #deck-metrics-strip .dk-foot-val { font-size: 12px; font-weight: 500; line-height: 1.25; color: var(--agc-fg-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #deck-metrics-strip .dk-foot-sub { min-height: 15px; min-width: 0; margin-top: 3px; display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; row-gap: 1px; font-size: 11px; line-height: 1.25; color: var(--agc-muted); }
        #deck-metrics-strip .dk-foot-sub > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #deck-metrics-strip .dk-foot-sub > [data-el="footOutSub"] { white-space: normal; word-break: keep-all; }
        #deck-metrics-strip .dk-foot-right { text-align: right; }
        #deck-metrics-strip .dk-ctx-pop .dk-panel-content:has(> .dk-foot-grid > [data-generation-block][hidden]) > .dk-divider { margin: calc(var(--agy-section-gap, 9px) - 2px) 0; }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) { display: block; }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"] { display: flex; align-items: center; gap: 5px; min-height: 16px; width: 100%; font-size: 12px; line-height: 1.3; color: var(--agc-muted); }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"] .dk-foot-top,
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"] .dk-foot-sub {
          display: contents;
          font-size: inherit;
          line-height: inherit;
        }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-ring { order: 1; width: 10.5px; height: 10.5px; }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"] { order: 2; }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-pct {
          order: 3;
          font-size: 12px;
          font-weight: 500;
          line-height: 1.3;
          color: var(--agc-fg);
        }
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-k { order: 4; margin-left: auto; font-size: 12px; line-height: 1.3; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"],
        #deck-metrics-strip[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"] { display: grid; grid-template-columns: 6px minmax(0, 1fr) auto minmax(31px, auto); gap: 0 10px; align-items: center; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-ring,
        #deck-metrics-strip[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-ring { grid-column: 1; grid-row: 1; width: 8px; height: 8px; justify-self: center; overflow: visible; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"],
        #deck-metrics-strip[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .dk-foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"] { grid-column: 2; grid-row: 1; margin-left: -5px; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-pct,
        #deck-metrics-strip[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-pct { grid-column: 3; grid-row: 1; justify-self: end; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-k,
        #deck-metrics-strip[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .dk-foot-grid:has(> [data-generation-block][hidden]) .dk-cache-k { grid-column: 4; grid-row: 1; margin-left: 0; justify-self: end; }
        #deck-metrics-strip .dk-cache-ring { width: 10px; height: 10px; flex-shrink: 0; display: block; color: var(--agc-subtle); transition: color 0.18s ease; }
        #deck-metrics-strip .dk-cache-ring[data-icon-state="warm"] { color: var(--agc-good); }
        #deck-metrics-strip .dk-cache-ring[data-icon-state="warning"] { color: var(--agc-warn); }
        #deck-metrics-strip .dk-cache-ring[data-icon-state="expired"] { color: var(--agc-danger); }
        #deck-metrics-strip [data-el="ctxIconSvg"][data-cache-state="warning"] { color: var(--agc-warn); }
        #deck-metrics-strip [data-el="ctxIconSvg"][data-cache-state="cold"] { color: var(--agc-danger); }
        #deck-metrics-strip .dk-foot-grid [data-el="rowCacheHit"][data-cache-status="warning"] .dk-cache-pct,
        #deck-metrics-strip .dk-foot-grid [data-el="rowCacheHit"][data-cache-status="warning"] .dk-cache-k,
        #deck-metrics-strip .dk-foot-grid:has(> [data-generation-block][hidden]) [data-el="rowCacheHit"][data-cache-status="warning"] .dk-cache-pct { color: var(--agc-warn); }
        #deck-metrics-strip .dk-foot-grid [data-el="rowCacheHit"][data-cache-status="cold"] .dk-cache-k { color: var(--agc-danger); }
        #deck-metrics-strip .dk-cache-k:empty { display: none; }
        #deck-metrics-strip .dk-speed-toggle { appearance: none; border: none; background: transparent; font: inherit; color: inherit; text-align: center; flex: 0 1 auto; width: auto; max-width: 100%; min-width: 0; padding: 2px 5px; margin: -2px 0; border-radius: 4.5px; cursor: pointer; transition: background 0.14s ease, transform 0.1s ease; }
        #deck-metrics-strip .dk-speed-toggle .dk-foot-top, #deck-metrics-strip .dk-speed-toggle .dk-foot-sub { justify-content: center; flex-wrap: nowrap; white-space: nowrap; }
        #deck-metrics-strip .dk-speed-toggle:hover { background: var(--agc-pill-hover); }
        #deck-metrics-strip .dk-speed-toggle:active { background: var(--agc-pill-active); transform: scale(0.985); }
        #deck-metrics-strip .dk-speed-slot { width: 11px; height: 9px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--agc-subtle); }
        #deck-metrics-strip .dk-speed-slot[data-tier="green"] { color: var(--agc-good); }
        #deck-metrics-strip .dk-speed-slot[data-tier="yellow"] { color: var(--agc-warn); }
        #deck-metrics-strip .dk-speed-slot[data-tier="red"] { color: var(--agc-danger); }
        #deck-metrics-strip .dk-speed-slot[data-mode="total"] [data-el="speedGlyphStream"], #deck-metrics-strip .dk-speed-slot[data-mode="stream"] [data-el="speedGlyphTotal"] { display: none; }
        /* Quota Popover */
        #deck-metrics-strip .dk-quota-pop {
          width: max-content;
        }
        #deck-metrics-strip[data-quota-indicator="bar"] .dk-quota-pop {
          min-width: min(228px, var(--dk-pop-max-width, calc(100vw - 16px)));
        }
        /* One grid for the whole popover; groups, rows and the pct+indicator
           cell are subgrids, so every column lines up across all groups. */
        #deck-metrics-strip .dk-quota-pop > .dk-panel-content {
          display: grid;
          grid-template-columns: minmax(48px, max-content) max-content max-content minmax(0, max-content);
          column-gap: 8px;
          align-content: start;
        }
        #deck-metrics-strip[data-quota-indicator="bar"] .dk-quota-pop > .dk-panel-content {
          grid-template-columns: minmax(48px, max-content) minmax(46px, 1fr) max-content minmax(0, max-content);
        }
        #deck-metrics-strip[data-language^="zh"] .dk-quota-pop > .dk-panel-content {
          grid-template-columns: minmax(38px, max-content) max-content max-content minmax(0, max-content);
        }
        #deck-metrics-strip[data-language^="zh"][data-quota-indicator="bar"] .dk-quota-pop > .dk-panel-content {
          grid-template-columns: minmax(38px, max-content) minmax(46px, 1fr) max-content minmax(0, max-content);
        }
        #deck-metrics-strip .dk-quota-pop:not(:has(.dk-q-mid:not(:empty))) .dk-q-mid { display: none; }
        #deck-metrics-strip .dk-quota-pop:not(:has(.dk-q-mid:not(:empty))) > .dk-panel-content {
          grid-template-columns: minmax(48px, max-content) max-content max-content;
        }
        #deck-metrics-strip[data-quota-indicator="bar"] .dk-quota-pop:not(:has(.dk-q-mid:not(:empty))) > .dk-panel-content {
          grid-template-columns: minmax(48px, max-content) minmax(46px, 1fr) max-content;
        }
        #deck-metrics-strip[data-language^="zh"] .dk-quota-pop:not(:has(.dk-q-mid:not(:empty))) > .dk-panel-content {
          grid-template-columns: minmax(38px, max-content) max-content max-content;
        }
        #deck-metrics-strip[data-language^="zh"][data-quota-indicator="bar"] .dk-quota-pop:not(:has(.dk-q-mid:not(:empty))) > .dk-panel-content {
          grid-template-columns: minmax(38px, max-content) minmax(46px, 1fr) max-content;
        }
        #deck-metrics-strip .dk-q-group {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: subgrid;
          align-items: center;
          row-gap: var(--agy-row-gap);
          margin: 0;
          transition: opacity .16s ease;
        }
        #deck-metrics-strip .dk-q-row {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: subgrid;
          align-items: center;
          font-size: 11px;
          line-height: 1.35;
          font-variant-numeric: tabular-nums;
          border-radius: 4.5px;
          padding: 2.5px 5px;
          margin: 0 -5px;
          transition: background 0.14s ease;
        }
        #deck-metrics-strip .dk-q-row:hover { background: var(--agc-pill-hover); }
        #deck-metrics-strip .dk-q-title-row { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
        #deck-metrics-strip .dk-q-title {
          font-size: 12px;
          font-weight: 600;
          line-height: 1.35;
          color: var(--agc-fg);
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #deck-metrics-strip .dk-q-group[data-active="true"] .dk-q-title { color: var(--agc-fg-strong); }
        #deck-metrics-strip .dk-q-label { color: var(--agc-muted); }
        #deck-metrics-strip .dk-q-mid {
          grid-column: 4;
          text-align: right;
          font-size: 11px;
          color: var(--agc-muted);
        }
        #deck-metrics-strip .dk-q-right {
          grid-column: 2 / 4;
          display: grid;
          grid-template-columns: subgrid;
          align-items: center;
          column-gap: 8px;
          color: var(--agc-fg-strong);
          white-space: nowrap;
        }
        /* Optional presentation inspired by z21100644/agy-capsule PR #1.
           Both styles use the existing four-category telemetry, unchanged. */
        #deck-metrics-strip[data-highlight-active-model="true"] .dk-q-group[data-active="false"] { opacity: .54; }
        #deck-metrics-strip[data-highlight-active-model="true"] .dk-q-group[data-active="false"]:hover { opacity: .96; }
        #deck-metrics-strip .dk-q-pct { justify-self: end; font-weight: 500; color: var(--agc-fg-strong); }
        #deck-metrics-strip .dk-q-row[data-tone="warn"] .dk-q-pct { color: var(--agc-warn); }
        #deck-metrics-strip .dk-q-row[data-tone="danger"] .dk-q-pct { color: var(--agc-danger); font-weight: 600; }
        #deck-metrics-strip .dk-q-meter { width: 100%; min-width: 34px; height: 4px; border-radius: 99px; overflow: hidden; background: var(--agc-track); box-shadow: inset 0 0 0 0.5px var(--agc-track-ring); }
        #deck-metrics-strip .dk-q-meter > span { display: block; height: 100%; border-radius: inherit; background-image: linear-gradient(180deg, var(--agc-seg-sheen) 0%, transparent 72%); transition: width 0.25s ease; }
        #deck-metrics-strip .dk-q-active { display: none; align-items: center; gap: 4px; font-size: 11px; font-weight: 400; color: var(--agc-fg); white-space: nowrap; flex-shrink: 0; }
        #deck-metrics-strip .dk-q-active-dot { width: 4.5px; height: 4.5px; border-radius: 50%; background: var(--agc-good); box-shadow: inset 0 0.5px 0 var(--agc-dot-rim); flex-shrink: 0; }
        #deck-metrics-strip[data-highlight-active-model="true"] .dk-q-group[data-active="true"] .dk-q-active { display: inline-flex; }
        /* Shared spacing rules; indicator and marker are independent. */
        #deck-metrics-strip .dk-list { row-gap: var(--agy-row-gap); }
        #deck-metrics-strip .dk-generation { margin-top: var(--agy-section-gap); padding-top: var(--agy-section-gap); }
        #deck-metrics-strip .dk-q-group + .dk-q-group { margin-top: var(--agy-section-gap); padding-top: var(--agy-section-gap); border-top: 0.5px solid var(--agc-divider); }
        #deck-metrics-strip .dk-q-row:last-child { margin-bottom: 0; }
        #deck-metrics-strip[data-panel-layout="matched"] .dk-ctx-pop > .dk-panel-content { height: 100%; display: flex; flex-direction: column; justify-content: space-between; }
        #deck-metrics-strip[data-panel-layout="matched"] .dk-quota-pop > .dk-panel-content { height: 100%; align-content: space-between; }
        #deck-metrics-strip[data-label-case="lowercase"] .dk-used-pct,
        #deck-metrics-strip[data-label-case="lowercase"] .dk-foot-sub,
        #deck-metrics-strip[data-label-case="lowercase"] .dk-item-label,
        #deck-metrics-strip[data-label-case="lowercase"] .turn-bar-label,
        #deck-metrics-strip[data-label-case="lowercase"] .turn-bar-short,
        #deck-metrics-strip[data-label-case="lowercase"] .dk-q-label { text-transform: lowercase; }
        /* Context breakdown / turn metrics: columns (vertical lines) or rows (marker + label + values). */
        #deck-metrics-strip:not([data-context-layout="rows"]) .dk-item-pct { display: none; }
        #deck-metrics-strip[data-column-percent="true"]:not([data-context-layout="rows"]) .dk-item-pct { display: block; }
        #deck-metrics-strip[data-column-label="false"]:not([data-context-layout="rows"]) .dk-item-label,
        #deck-metrics-strip[data-column-value="false"]:not([data-context-layout="rows"]) .dk-item-k { display: none; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-list { grid-template-columns: auto minmax(0, 1fr) auto minmax(36px, auto); column-gap: 8px; align-items: center; margin: 0 -5px; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-row,
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-item { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; padding: 2.5px 5px; border-radius: 4.5px; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-row:hover,
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-item:hover { background: var(--agc-pill-hover); }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-body { grid-column: 2 / -1; display: grid; grid-template-columns: subgrid; column-gap: 10px; align-items: center; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-label { grid-column: 1; grid-row: 1; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-pct { grid-column: 2; grid-row: 1; justify-self: end; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-k { grid-column: 3; grid-row: 1; justify-self: end; }
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-list { grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 8px; row-gap: var(--agy-row-gap); align-items: center; margin: 0 -5px; }
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-label { grid-column: 2; grid-row: 1; display: block; }
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-short { display: none; }
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-item[data-turn-row="requests"] { container-type: normal; }
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-val { grid-column: 3; grid-row: 1; justify-self: end; }
        #deck-metrics-strip[data-context-layout="rows"] .dk-item-row > .dk-dot,
        #deck-metrics-strip[data-turn-layout="rows"] .turn-bar-line { grid-column: 1; grid-row: 1; align-self: center; width: 6px; height: 6px; margin: 0; border-radius: 2px; box-shadow: inset 0 0.5px 0 var(--agc-dot-rim); }
        #deck-metrics-strip[data-context-marker="dot"][data-context-layout="rows"] .dk-item-row > .dk-dot,
        #deck-metrics-strip[data-turn-marker="dot"][data-turn-layout="rows"] .turn-bar-line { border-radius: 50%; }
        #deck-metrics-strip[data-show-context-breakdown="false"] .dk-list { display: none; }
        #deck-metrics-strip[data-show-context-breakdown="false"] .dk-track { margin-bottom: 0; }
        #deck-metrics-strip .dk-item-label { order: var(--agy-order-label, 0); }
        #deck-metrics-strip .dk-item-k { order: var(--agy-order-value, 1); }
        #deck-metrics-strip .dk-item-pct { order: var(--agy-order-percent, 2); }
      </style>

      <!-- Context Capsule + Popover -->
      <div class="dk-grp" data-el="grpCtx">
        <button type="button" class="dk-pill" aria-expanded="false">
          <svg class="dk-svg" data-el="ctxIconSvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
          <span class="dk-val" data-k="pillCtx">--%</span>
          <span class="dk-speed" data-el="pillSpeed" hidden><span class="dk-speed-dot" aria-hidden="true"></span><span data-generation="speed"></span></span>
        </button>
        <div class="dk-pop dk-ctx-pop">
          <div class="dk-panel-content">
          <div class="dk-head-row" data-context-tip="overview">
            <div class="dk-used-pct"><span data-i18n="ctxTitle">Context</span> <span data-k="usedPctText">0%</span> <span data-i18n="used">used</span></div>
            <div class="dk-used-frac" data-k="usedFrac">0 / --</div>
          </div>
          <div class="dk-track" data-context-tip="overview">
            <div class="dk-seg" data-el="segTurn0" data-cat="turn0" style="width: 0%"></div>
            <div class="dk-seg" data-el="segRead" data-cat="read" style="width: 0%"></div>
            <div class="dk-seg" data-el="segThink" data-cat="think" style="width: 0%"></div>
            <div class="dk-seg" data-el="segOut" data-cat="out" style="width: 0%"></div>
          </div>
          <div class="dk-list">
            <div class="dk-item-row" data-cat="turn0" data-context-tip="turn0">
              <span class="dk-dot"></span>
              <div class="dk-item-body"><span class="dk-item-label" data-i18n="turn0">Turn0</span><span class="dk-item-k" data-k="valTurn0K">0</span><span class="dk-item-pct" data-k="valTurn0Pct">0%</span></div>
            </div>
            <div class="dk-item-row" data-cat="read" data-context-tip="read">
              <span class="dk-dot"></span>
              <div class="dk-item-body"><span class="dk-item-label" data-i18n="read">Read</span><span class="dk-item-k" data-k="valReadK">0</span><span class="dk-item-pct" data-k="valReadPct">0%</span></div>
            </div>
            <div class="dk-item-row" data-cat="think" data-context-tip="think">
              <span class="dk-dot"></span>
              <div class="dk-item-body"><span class="dk-item-label" data-i18n="think">Think</span><span class="dk-item-k" data-k="valThinkK">0</span><span class="dk-item-pct" data-k="valThinkPct">0%</span></div>
            </div>
            <div class="dk-item-row" data-cat="out" data-context-tip="write">
              <span class="dk-dot"></span>
              <div class="dk-item-body"><span class="dk-item-label" data-i18n="write">Write</span><span class="dk-item-k" data-k="valOutK">0</span><span class="dk-item-pct" data-k="valOutPct">0%</span></div>
            </div>
          </div>
          ${presentation.turnMetricsMarkup('dk-generation')}
          <div class="dk-divider"></div>
          <div class="dk-foot-grid">
            <div class="dk-foot-col" data-el="rowCacheHit">
              <div class="dk-foot-top"><svg class="dk-cache-ring" data-el="cacheRing" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--agc-ring-track, rgba(142,142,147,0.22))" stroke-width="1.8"></circle><circle data-el="cacheArc" cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="0 28.27" transform="rotate(-90 6 6)" style="display:none"></circle></svg><span class="dk-foot-val dk-cache-pct" data-k="valCacheHit" data-el="valCacheHitEl">0%</span></div>
              <div class="dk-foot-sub"><span data-i18n="cache">Cache</span><span class="dk-cache-k" data-k="valCacheHitK"></span></div>
            </div>
            <div class="dk-foot-gen-wrap" data-generation-block>
              <button type="button" class="dk-foot-col dk-speed-toggle" data-el="speedToggle" aria-pressed="false">
                <div class="dk-foot-top"><span class="dk-speed-slot" data-el="speedSlot" data-mode="total"><svg viewBox="0 0 14 12" width="10.5" height="9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path data-el="speedGlyphTotal" d="M2.6 3.1L6.3 6.0 2.6 8.9M7.5 8.9H11.5"></path><path data-el="speedGlyphStream" d="M3.8 9.5A2.3 2.3 0 0 1 4.07 4.92 3.2 3.2 0 0 1 10.4 5.5 2.0 2.0 0 0 1 10.5 9.5Z"></path></svg></span><span class="dk-foot-val" data-generation="speed">—</span></div>
                <div class="dk-foot-sub"><span data-generation="timing">—</span></div>
              </button>
              <div class="dk-foot-col dk-foot-right" data-el="footOutCol">
                <div class="dk-foot-top dk-foot-top-right"><span class="dk-foot-val" data-el="footOutVal">—</span></div>
                <div class="dk-foot-sub dk-foot-sub-right"><span data-el="footOutSub">—</span></div>
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>

      <span class="dk-strip-sep dk-strip-sep-quota" data-el="sepQuota" aria-hidden="true"></span>

      <!-- Merged Quota Capsule (5h + Weekly) + Popover -->
      <div class="dk-grp" data-el="grpQuota">
        <button type="button" class="dk-pill dk-pill-quota" aria-expanded="false">
          <span class="dk-q-pair" data-el="pair5h">
            <svg class="dk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><polyline points="12 6.8 12 12 15.6 14.1"/></svg>
            <span class="dk-val" data-k="pill5h">--%</span>
          </span>
          <span class="dk-q-pair" data-el="pairWk">
            <svg class="dk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3.5" ry="3.5"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span class="dk-val" data-k="pillWk">--%</span>
          </span>
        </button>
        <div class="dk-pop dk-quota-pop" data-el="quotaPop"></div>
      </div>

      <span class="dk-strip-sep dk-strip-sep-err" data-el="sepErr" aria-hidden="true" hidden></span>

      <div class="dk-grp" data-el="grpError" hidden>
        <button type="button" class="dk-pill" aria-expanded="false">
          <svg class="dk-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>
          <span class="dk-val" data-request-error="label"></span>
        </button>
        <div class="dk-pop dk-error-pop">
          <div class="dk-error-head"><span class="dk-error-dot" aria-hidden="true"></span><span class="dk-error-heading" data-request-error="label"></span></div>
          <div class="dk-divider"></div>
          <div class="dk-error-detail" data-request-error="detail"></div>
          <div class="dk-error-diagnostic" data-request-error="diagnostic"></div>
        </div>
      </div>
    `;

    // Only native layout integration stays outside the shadow boundary.
    let nativeStyle = document.getElementById('agy-capsule-native-layout');
    if (!nativeStyle) {
      nativeStyle = document.createElement('style');
      nativeStyle.id = 'agy-capsule-native-layout';
      document.head.appendChild(nativeStyle);
    }
    nativeStyle.textContent = `
        .agy-composer-footer button[data-deck-turbo-collapsed="true"] {
          width: 28px !important; min-width: 28px !important; max-width: 28px !important;
          padding: 6px !important; gap: 0 !important; justify-content: center !important;
        }
        .agy-composer-footer button[data-deck-turbo-collapsed="true"] > :not(:first-child) { display: none !important; }
        .agy-composer-footer button[data-deck-turbo-collapsed="true"] > svg:first-child { width: 16px !important; height: 16px !important; flex-shrink: 0 !important; }
        .agy-composer-footer .dk-fl-squeezed {
          min-width: 0 !important;
          flex-shrink: 1 !important;
        }
        .agy-composer-footer .dk-model-squeezed {
          min-width: 0 !important;
          flex: 0 1 auto !important;
          overflow: hidden !important;
          max-width: 100% !important;
        }
        .agy-composer-footer .dk-model-squeezed .dk-squeeze-box,
        .agy-composer-footer .dk-model-squeezed .dk-squeeze-item {
          min-width: 0 !important;
          max-width: 100% !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }
        .agy-composer-footer .dk-model-squeezed .dk-squeeze-box,
        .agy-composer-footer .dk-model-squeezed-hard .dk-squeeze-item {
          flex-shrink: 1 !important;
        }
        .agy-composer-footer .dk-model-squeezed svg {
          flex-shrink: 0 !important;
        }
    `;
    root._dispose = () => {
      release(root);
      nativeStyle.remove();
      host.remove();
      if (window.__agyCapsuleCleanup === root._dispose) delete window.__agyCapsuleCleanup;
    };
    window.__agyCapsuleCleanup = root._dispose;

    const closePinned = (dismiss = false) => {
      const pinned = root._pinnedGroup;
      if (pinned) {
        pinned.removeAttribute('data-pinned');
        if (dismiss) pinned.dataset.dismissed = 'true';
        pinned.querySelector('.dk-pill').setAttribute('aria-expanded', 'false');
      }
      root._pinnedGroup = null;
      root.removeAttribute('data-pinned');
    };
    root._layoutPopovers = (grp = root._pinnedGroup || root.querySelector('.dk-grp:hover')) => {
      const pop = grp?.querySelector('.dk-pop');
      if (!pop) {
        if (root.dataset.panelLayout !== 'matched' && root._heightKey) root._fitPanelHeights?.();
        return;
      }
      // Constrain width before measuring heights or positioning; moving a panel
      // alone cannot make it fit inside a narrower clipping ancestor.
      let minLeft = 8;
      let maxRight = window.innerWidth - 8;
      for (let el = root; el && el !== document.documentElement; el = el.parentElement || el.getRootNode().host) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'visible' && !/paint|strict|content/.test(cs.contain)) continue;
        const innerLeft = el.getBoundingClientRect().left + el.clientLeft;
        minLeft = Math.max(minLeft, innerLeft + 4);
        maxRight = Math.min(maxRight, innerLeft + el.clientWidth - 4);
      }
      const limit = `${Math.max(0, maxRight - minLeft)}px`;
      if (root.style.getPropertyValue('--dk-pop-max-width') !== limit) root.style.setProperty('--dk-pop-max-width', limit);
      root._fitPanelHeights?.();
      const width = pop ? (parseFloat(getComputedStyle(pop).width) || pop.getBoundingClientRect().width) : 0;
      if (!width) return;
      const pill = grp.querySelector('.dk-pill').getBoundingClientRect();
      const stripLeft = root.getBoundingClientRect().left;
      let left = Math.max(stripLeft, pill.right - width);
      left = Math.max(minLeft, Math.min(left, maxRight - width));
      pop.style.left = (left - grp.getBoundingClientRect().left) + 'px';
    };
    for (const grp of root.querySelectorAll('.dk-grp')) {
      grp.addEventListener('mouseenter', () => {
        root._refreshCacheTooltip?.();
        grp.removeAttribute('data-dismissed');
        if (!root._pinnedGroup || root._pinnedGroup === grp) grp.querySelector('.dk-pill').setAttribute('aria-expanded', 'true');
        root._layoutPopovers(root._pinnedGroup || grp);
      });
      grp.addEventListener('mouseleave', () => {
        grp.removeAttribute('data-dismissed');
        if (root._pinnedGroup === grp) return;
        grp.querySelector('.dk-pill').setAttribute('aria-expanded', 'false');
        const pop = grp.querySelector('.dk-pop');
        if (pop) pop.style.left = '';
      });
      grp.querySelector('.dk-pill').addEventListener('click', (event) => {
        event.stopPropagation();
        root._refreshCacheTooltip?.();
        const wasPinned = root._pinnedGroup === grp;
        closePinned();
        if (wasPinned) {
          grp.dataset.dismissed = 'true';
        } else {
          grp.removeAttribute('data-dismissed');
          grp.dataset.pinned = 'true';
          root.dataset.pinned = 'true';
          root._pinnedGroup = grp;
          grp.querySelector('.dk-pill').setAttribute('aria-expanded', 'true');
          root._layoutPopovers(grp);
        }
      });
    }
    root._onOutsideClick = (event) => { if (!event.composedPath().includes(root)) closePinned(); };
    root._onEscape = (event) => {
      if (event.key !== 'Escape') return;
      closePinned(true);
      for (const grp of root.querySelectorAll('.dk-grp')) {
        grp.dataset.dismissed = 'true';
        grp.querySelector('.dk-pill').setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('click', root._onOutsideClick);
    document.addEventListener('keydown', root._onEscape);
    root._onResize = () => root._scheduleLayout?.();
    window.addEventListener('resize', root._onResize);
    root.querySelector('[data-el="rowCacheHit"]').addEventListener('mouseenter', () => root._refreshCacheTooltip?.());
    const ctxPopInit = root.querySelector('.dk-ctx-pop');
    if (ctxPopInit && !ctxPopInit.dataset.speedMode) ctxPopInit.dataset.speedMode = 'total';
    for (const target of root.querySelectorAll('.dk-seg[data-cat], .dk-item-row[data-cat]')) {
      const cat = target.dataset.cat;
      target.addEventListener('mouseenter', () => { if (ctxPopInit) ctxPopInit.dataset.hoverCat = cat; });
      target.addEventListener('mouseleave', () => { if (ctxPopInit && ctxPopInit.dataset.hoverCat === cat) delete ctxPopInit.dataset.hoverCat; });
    }
    const speedToggleBtn = root.querySelector('[data-el="speedToggle"]');
    if (speedToggleBtn) {
      speedToggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!ctxPopInit) return;
        ctxPopInit.dataset.speedMode = ctxPopInit.dataset.speedMode === 'stream' ? 'total' : 'stream';
        const cur = root._deckQuotas;
        if (cur) presentation.renderGeneration(ctxPopInit, cur.generation, root._deckLabels, cur.prefs);
        if (root.dataset.panelLayout === 'matched') {
          root._heightKey = '';
          root._layoutPopovers?.();
        }
      });
    }
  }

  // Apply skin, theme, i18n, and values before connecting the shadow host so first paint has zero flash.
  const quotaPop = root.querySelector('[data-el="quotaPop"]');
  if (quotaPop && quotaPop.innerHTML !== d.quotaHtml) {
    quotaPop.innerHTML = d.quotaHtml;
    root._i18nKey = '';
  }

  const nextTheme = detectHostTheme();
  if (root.dataset.theme !== nextTheme) root.dataset.theme = nextTheme;
  const labels = presentation.apply(root, d.prefs);
  root._deckQuotas = d;
  root._deckLabels = labels;

  presentation.renderContextTooltips(root, d.contextData, labels);
  const alerts = presentation.renderAlerts(root, { ...d.contextData, requestError: d.requestError }, d.prefs, labels);
  root.querySelector('[data-el="grpQuota"]').hidden = d.cloudPaygo;
  const sepQuota = root.querySelector('[data-el="sepQuota"]');
  const sepErr = root.querySelector('[data-el="sepErr"]');
  if (sepQuota) sepQuota.hidden = d.cloudPaygo;
  if (sepErr) sepErr.hidden = !alerts.visible;
  if (root._pinnedGroup?.hidden) {
    root._pinnedGroup.removeAttribute('data-pinned');
    root._pinnedGroup.querySelector('.dk-pill').setAttribute('aria-expanded', 'false');
    root._pinnedGroup = null;
    root.removeAttribute('data-pinned');
  }
  root._refreshCacheTooltip = () => {
    const cur = root._deckQuotas;
    if (!cur) return;
    const tip = presentation.cacheTooltip(cur.cache, root._deckLabels, Date.now(), cur.prefs);
    const el = root.querySelector('[data-el="rowCacheHit"]');
    if (el && el.title !== tip) el.title = tip;
  };
  root._refreshCacheTooltip();
  const ctxPopEl = root.querySelector('.dk-ctx-pop');
  if (ctxPopEl) presentation.renderGeneration(ctxPopEl, d.generation, labels, d.prefs);
  presentation.renderTurnMetrics(root, d.turnMetrics, labels, d.prefs);
  const pillSpeed = root.querySelector('[data-el="pillSpeed"]');
  const tps = d.turnSpeed?.generation?.tps;
  // Turn scope comes from persisted USER_INPUT, not cancel-button appearance.
  // Activity and the last completed request's speed are independent signals.
  const now = Date.now();
  const turnKey = location.pathname + ':' + (d.turnSpeed?.userStepIndex ?? 'none');
  const requestIndex = d.turnSpeed?.generation?.requestIndex ?? null;
  const running = !!d.turnSpeed?.hasActiveStep || !!footerLeft.parentElement.querySelector('[data-testid="input-cancel-button"]');
  const hasSpeed = Number.isFinite(tps) && tps >= 0;
  const motionEnabled = d.prefs?.speedAnimation === true;
  pillSpeed.hidden = d.prefs?.showSpeed === false || (!d.turnSpeed && !running);
  const speedValue = pillSpeed.querySelector('[data-generation="speed"]');
  const turnSpeedView = presentation.generationText(d.turnSpeed?.generation || {}, labels);
  if (speedValue.textContent !== turnSpeedView.speed) speedValue.textContent = turnSpeedView.speed;
  const speedTitle = hasSpeed ? turnSpeedView.speedTitle : '';
  if (pillSpeed.title !== speedTitle) pillSpeed.title = speedTitle;
  let activity = root._speedActivity;
  if (!activity || activity.turnKey !== turnKey) {
    activity = root._speedActivity = { turnKey, running: false, requestIndex: null, coolUntil: 0 };
  }
  if (running) activity.coolUntil = 0;
  else if (activity.running) activity.coolUntil = now + 15000;
  else if (requestIndex !== null && requestIndex !== activity.requestIndex) {
    // Use response completion time, not unrelated tool activity.
    const recordedAt = d.turnSpeed?.completedAtMs || 0;
    if (recordedAt > 0 && recordedAt <= now) activity.coolUntil = Math.max(activity.coolUntil, recordedAt + 15000);
  }
  activity.running = running;
  activity.requestIndex = requestIndex;
  if (motionEnabled && !pillSpeed.hidden) {
    pillSpeed.dataset.motion = running ? 'active' : activity.coolUntil > now ? 'recent' : 'idle';
    pillSpeed.dataset.tier = hasSpeed ? (tps >= 25 ? 'green' : tps >= 10 ? 'yellow' : 'red') : 'unknown';
  } else {
    pillSpeed.removeAttribute('data-motion');
    pillSpeed.removeAttribute('data-tier');
  }
  const contextPill = root.querySelector('[data-el="grpCtx"] .dk-pill');
  if (contextPill.getAttribute('aria-label') !== labels.context) contextPill.setAttribute('aria-label', labels.context);
  const quotaPill = root.querySelector('[data-el="grpQuota"] .dk-pill');
  if (quotaPill.getAttribute('aria-label') !== labels.quota) quotaPill.setAttribute('aria-label', labels.quota);

  const setK = (k, val) => {
    const el = root.querySelector(`[data-k="${k}"]`);
    if (el && el.textContent !== val) el.textContent = val;
  };

  setK('pillCtx', d.pillCtx);
  setK('usedPctText', d.pillCtx);
  setK('usedFrac', d.usedFrac);
  setK('valCacheHit', d.valCacheHit);
  setK('valTurn0K', d.valTurn0K);
  setK('valReadK', d.valReadK);
  setK('valThinkK', d.valThinkK);
  setK('valOutK', d.valOutK);
  for (const [cat, val] of [['turn0', d.valTurn0K], ['read', d.valReadK], ['think', d.valThinkK], ['out', d.valOutK]]) {
    const row = root.querySelector(`.dk-item-row[data-cat="${cat}"]`);
    const z = val === '0' ? 'true' : 'false';
    if (row && row.dataset.zero !== z) row.dataset.zero = z;
  }
  setK('valTurn0Pct', d.valTurn0Pct);
  setK('valReadPct', d.valReadPct);
  setK('valThinkPct', d.valThinkPct);
  setK('valOutPct', d.valOutPct);

  // Update progress bar & cache cooling indicator before host attachment
  const segRead = root.querySelector('[data-el="segRead"]');
  const segOut = root.querySelector('[data-el="segOut"]');
  const segThink = root.querySelector('[data-el="segThink"]');
  const segTurn0 = root.querySelector('[data-el="segTurn0"]');
  const cacheRing = root.querySelector('[data-el="cacheRing"]');
  const cacheArc = root.querySelector('[data-el="cacheArc"]');
  const ctxIconSvg = root.querySelector('[data-el="ctxIconSvg"]');

  if (segRead && segRead.style.width !== d.segReadW) segRead.style.width = d.segReadW;
  if (segOut && segOut.style.width !== d.segOutW) segOut.style.width = d.segOutW;
  if (segThink && segThink.style.width !== d.segThinkW) segThink.style.width = d.segThinkW;
  if (segTurn0 && segTurn0.style.width !== d.segTurn0W) segTurn0.style.width = d.segTurn0W;
  if (ctxIconSvg) {
    if (ctxIconSvg.style.color) ctxIconSvg.style.color = '';
    const cacheState = d.cacheStatus || 'fresh';
    if (ctxIconSvg.dataset.cacheState !== cacheState) ctxIconSvg.dataset.cacheState = cacheState;
  }
  presentation.renderCacheRing(cacheRing, cacheArc, d.cacheStatus, d.cacheHitPct);
  const rowCacheHit = root.querySelector('[data-el="rowCacheHit"]');
  if (rowCacheHit) {
    const cacheStatus = d.cacheStatus || 'fresh';
    if (rowCacheHit.dataset.cacheStatus !== cacheStatus) rowCacheHit.dataset.cacheStatus = cacheStatus;
  }
  const valCacheHitEl = root.querySelector('[data-el="valCacheHitEl"]');
  if (valCacheHitEl) {
    if (valCacheHitEl.style.color) valCacheHitEl.style.color = '';
    if (valCacheHitEl.style.textDecoration !== d.cacheValDeco) valCacheHitEl.style.textDecoration = d.cacheValDeco;
    if (valCacheHitEl.style.opacity !== d.cacheValOp) valCacheHitEl.style.opacity = d.cacheValOp;
  }
  const valCacheHitKEl = root.querySelector('[data-k="valCacheHitK"]');
  if (valCacheHitKEl) {
    const cacheSubText = d.cacheStatus === 'cold' ? (labels.cacheExpiredTag || 'expired') : (d.valCacheHitK || d.cacheAge || '');
    if (valCacheHitKEl.textContent !== cacheSubText) valCacheHitKEl.textContent = cacheSubText;
    if (valCacheHitKEl.style.color) valCacheHitKEl.style.color = '';
  }

  if (!footerLeft.contains(host)) {
    footerLeft.appendChild(host);
  }

  // Match active model to quota pills
  // Reveals reserve their final width before fitting the footer. Animating layout
  // width from zero lets the fit check pass too early and overlap native buttons.
  // Leaving items may shrink; they never need more room than the fitted layout.
  const motion = (key, el, restore) => {
    const state = root._motionPrev || (root._motionPrev = {});
    // Still collapsing: a later re-render hiding it again must not cut the animation short.
    if (el._leaving) {
      if (el.hidden) { el.hidden = false; return; }
      el._leaving.cancel(); el._leaving = null;
    }
    const visible = !el.hidden;
    const text = el.textContent;
    const width = visible ? el.getBoundingClientRect().width : 0;
    const p = state[key];
    state[key] = { visible, text, width };
    if (!p || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (visible === p.visible && (!visible || text === p.text)) return;
    for (const a of el.getAnimations()) a.cancel();
    const gap = parseFloat(getComputedStyle(el.parentElement).columnGap) || 0;
    // Cancel the gap on the side that has a neighbour, so a leading item doesn't slide outside its capsule.
    const prevSib = el.previousElementSibling;
    const side = prevSib && !prevSib.hidden && getComputedStyle(prevSib).display !== 'none' ? 'marginLeft' : 'marginRight';
    const box = (w, o, m) => ({ overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: w + 'px', minWidth: Math.min(w, width || w) + 'px', opacity: o, [side]: m + 'px' });
    const timing = { duration: 220, easing: 'ease' };
    if (visible && !p.visible) {
      el.animate([{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0)' }], timing);
    } else if (!visible && p.visible) {
      el.hidden = false;
      restore?.(p.text); // collapse what was shown, not the cleared value
      const out = el.animate([{ ...box(p.width, 1, 0), minWidth: '0px' }, { ...box(0, 0, -gap), minWidth: '0px' }], { ...timing, fill: 'forwards' });
      el._leaving = out;
      out.onfinish = () => { el._leaving = null; el.hidden = true; out.cancel(); root._scheduleLayout?.(); };
    } else if (Math.abs(width - p.width) > 0.5) {
      el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease' });
    }
  };
  const applyModelQuota = () => {
    let mt = '';
    for (const child of footerLeft.children) {
      if (child !== host && child.textContent) {
        mt += ' ' + child.textContent.trim();
      }
    }
    mt = mt.trim().toLowerCase();
    const q = root._deckQuotas || d;
    const groups = q.quotaSummaryGroups || [];

    let matched = null;
    // 1. Match specific non-generic group titles (e.g. "Gemini 4 Argon", "Gemini 4 Carbon", "Claude and GPT models")
    for (const g of groups) {
      if (g.title === 'Gemini') continue;
      if (
        (g.rawName.includes('claude') || g.rawName.includes('gpt')) &&
        (mt.includes('claude') || mt.includes('sonnet') || mt.includes('opus') || mt.includes('gpt'))
      ) {
        matched = g;
        break;
      }
      const tokens = g.rawName
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !['gemini', 'model', 'models', 'and', 'the', 'for'].includes(t));
      if (tokens.some((t) => mt.includes(t))) {
        matched = g;
        break;
      }
    }

    // 2. Match explicit "Models within this group: ..." description list
    if (!matched) {
      const modelKeys = ['carbon', 'argon', 'hydrogen', 'flash', 'claude', 'sonnet', 'opus', 'gpt'];
      const activeKeys = modelKeys.filter((k) => mt.includes(k));
      if (activeKeys.length > 0) {
        matched = groups.find((g) => activeKeys.some((k) => g.modelsInGroup && g.modelsInGroup.includes(k))) || null;
      }
    }

    // 3. Fallback to main Gemini group (handles Ultra where Argon is part of Gemini Models)
    if (!matched) {
      matched = groups.find((g) => g.title === 'Gemini') || groups[0] || null;
    }
    for (const group of root.querySelectorAll('.dk-q-group')) {
      const isAct = group.dataset.pool === matched?.rawName ? 'true' : 'false';
      if (group.dataset.active !== isAct) group.dataset.active = isAct;
    }

    const q5hVal = matched ? matched.q5h || '--%' : '--%';
    const qWkVal = matched ? matched.qWk || '--%' : '--%';
    setK('pill5h', q5hVal);
    setK('pillWk', qWkVal);
    const toneFor = (str) => {
      const m = String(str || '').match(/^(\d+)%$/);
      if (!m) return '';
      const n = Number(m[1]);
      return n <= 10 ? 'danger' : n <= 25 ? 'warn' : '';
    };
    const hideAbsent = q.prefs?.hideUnavailableQuota === true;
    const pair5h = root.querySelector('[data-el="pair5h"]');
    const pairWk = root.querySelector('[data-el="pairWk"]');
    const t5h = toneFor(q5hVal);
    const tWk = toneFor(qWkVal);
    if (t5h) { if (pair5h.dataset.tone !== t5h) pair5h.dataset.tone = t5h; }
    else if (pair5h.hasAttribute('data-tone')) pair5h.removeAttribute('data-tone');
    if (tWk) { if (pairWk.dataset.tone !== tWk) pairWk.dataset.tone = tWk; }
    else if (pairWk.hasAttribute('data-tone')) pairWk.removeAttribute('data-tone');
    pair5h.hidden = hideAbsent && q5hVal === '--%' && qWkVal !== '--%';
    pairWk.hidden = hideAbsent && qWkVal === '--%' && q5hVal !== '--%';
    motion('pair5h', pair5h);
    motion('pairWk', pairWk);
    const prefWk = q5hVal === '--%' && qWkVal !== '--%' ? '1' : '0';
    if (root.dataset.preferWkOnly !== prefWk) root.dataset.preferWkOnly = prefWk;
    return mt;
  };
  root._applyModelQuota = applyModelQuota;
  const modelText = applyModelQuota();

  const getNativeVisualInfo = (el) => {
    let maxR = -Infinity;
    let svgClipped = false;
    const walk = (node, parentClip) => {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (cs.display === 'contents') {
        for (const child of node.children) walk(child, parentClip);
        return;
      }
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const r = node.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        if (tag === 'svg') {
          if (parentClip < Infinity && r.width > 0 && r.right > parentClip + 1) {
            svgClipped = true;
          }
          const visR = Math.min(r.right, parentClip);
          if (visR > maxR) maxR = visR;
          return;
        }
        const visR = Math.min(r.right, parentClip);
        if (visR > maxR) maxR = visR;
        const ownClip = cs.overflowX === 'hidden' || cs.overflowX === 'clip' ? r.right : Infinity;
        const nextClip = Math.min(parentClip, ownClip);
        if (cs.overflowX === 'visible' && node.scrollWidth > node.clientWidth + 1) {
          const overflowR = Math.min(r.left + node.scrollWidth, parentClip);
          if (overflowR > maxR) maxR = overflowR;
        }
        for (const child of node.children) walk(child, nextClip);
      } else {
        for (const child of node.children) walk(child, parentClip);
      }
    };
    walk(el, Infinity);
    return { maxR, svgClipped };
  };

  const adjustLayout = () => {
    if (root._adjustingLayout) return;
    root._adjustingLayout = true;
    try {
    const footer = footerLeft.parentElement;
    if (!footer || footer.getBoundingClientRect().width <= 0) return;
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const children = Array.from(footerLeft.children);
    const nativeChildren = children.slice(0, children.indexOf(host)).filter(el => visible(el) || el.classList.contains('dk-model-squeezed'));
    const modelTargets = nativeChildren.filter((c) => c.textContent && c.textContent.trim().length > 0);
    const turbo = footer.querySelector('[data-testid="permissions-selector-trigger"]');
    if (root._turboTarget && root._turboTarget !== turbo) root._turboTarget.removeAttribute('data-deck-turbo-collapsed');
    root._turboTarget = turbo;

    const isClippedEl = (el) => {
      if (el instanceof SVGElement) return false;
      const overflow = getComputedStyle(el).overflowX;
      if (overflow !== 'hidden' && overflow !== 'clip') return false;
      if (el.scrollWidth <= el.clientWidth + 2) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && el.getClientRects().length > 0;
    };

    const isNativeSqueezed = () => {
      for (const c of nativeChildren) {
        if (isClippedEl(c)) return true;
        for (const node of c.querySelectorAll('*')) {
          if (isClippedEl(node)) return true;
        }
      }
      return false;
    };

    const syncSqueezeClasses = (compress) => {
      footerLeft.classList.toggle('dk-fl-squeezed', !!compress);
      for (const mt of modelTargets) {
        mt.classList.toggle('dk-model-squeezed', !!compress);
        mt.classList.toggle('dk-model-squeezed-hard', compress === 'hard');
        if (!compress) {
          mt.classList.remove('dk-squeeze-box', 'dk-squeeze-item');
          for (const el of mt.querySelectorAll('.dk-squeeze-box, .dk-squeeze-item')) {
            el.classList.remove('dk-squeeze-box', 'dk-squeeze-item');
          }
          continue;
        }
        const tag = (el) => {
          const txt = el.textContent ? el.textContent.trim() : '';
          if (!txt) {
            el.classList.remove('dk-squeeze-box', 'dk-squeeze-item');
            return;
          }
          const isBoxOrLong = el.children.length > 0 || txt.length > 5;
          el.classList.toggle('dk-squeeze-box', isBoxOrLong);
          el.classList.toggle('dk-squeeze-item', !isBoxOrLong);
        };
        tag(mt);
        for (const el of mt.querySelectorAll('div, span, button, a, p, label')) tag(el);
      }
    };

    const compactCls = root.dataset.preferWkOnly === '1' ? 'dk-hide-5h' : 'dk-hide-wk';
    const modeClasses = ['dk-hide-speed', 'dk-hide-wk', 'dk-hide-5h', 'dk-hide-qval', 'dk-hide-cval', 'dk-hide-quota', 'dk-hide-error-label', 'dk-hide-ctx', 'dk-hide-all'];
    const modes = [
      { classes: [], compress: '' },
      // First reserve width by collapsing the native Turbo selector to its shield.
      // Keep it collapsed through ALL capsule stages, never alternate priorities.
      ...(turbo ? [{ classes: [], compress: '' }] : []),
      { classes: ['dk-hide-speed'], compress: '' },
      ...(alerts.visible ? [{ classes: ['dk-hide-error-label'], compress: '' }] : []),
      { classes: [compactCls, 'dk-hide-error-label'], compress: '' },
      { classes: [compactCls, 'dk-hide-qval', 'dk-hide-error-label'], compress: '' },
      { classes: [compactCls, 'dk-hide-qval', 'dk-hide-error-label', 'dk-hide-cval'], compress: '' },
      { classes: [compactCls, 'dk-hide-qval', 'dk-hide-error-label', 'dk-hide-cval'], compress: 'soft' },
      { classes: [compactCls, 'dk-hide-qval', 'dk-hide-error-label', 'dk-hide-cval'], compress: 'hard' },
      { classes: ['dk-hide-cval', 'dk-hide-quota', 'dk-hide-error-label'], compress: 'hard' },
      ...(alerts.visible ? [{ classes: ['dk-hide-ctx', 'dk-hide-quota', 'dk-hide-error-label'], compress: 'hard' }] : []),
      { classes: ['dk-hide-all'], compress: '' },
    ];

    for (const [modeIndex, mode] of modes.entries()) {
      if (turbo) {
        if (modeIndex > 0) turbo.setAttribute('data-deck-turbo-collapsed', 'true');
        else turbo.removeAttribute('data-deck-turbo-collapsed');
      }
      const classes = mode.classes.length > 0 && !mode.classes.includes('dk-hide-speed') ? ['dk-hide-speed', ...mode.classes] : mode.classes;
      for (const cls of modeClasses) {
        root.classList.toggle(cls, classes.includes(cls));
      }
      syncSqueezeClasses(mode.compress);
      if (mode.classes.includes('dk-hide-all')) break;

      const rootRect = root.getBoundingClientRect();
      if (rootRect.width <= 0) continue;

      const rightControls = footer
        ? Array.from(footer.children).filter((el) => {
            if (el === footerLeft || !visible(el) || !(el.textContent.trim() || el.querySelector('button, svg, img, input, a, [role="button"]'))) return false;
            const rect = el.getBoundingClientRect();
            const left = footerLeft.getBoundingClientRect();
            return rect.bottom > left.top + 2 && rect.top < left.bottom - 2;
          })
        : [];
      const rightMinLeft =
        rightControls.length > 0
          ? Math.min(...rightControls.map((el) => el.getBoundingClientRect().left))
          : Infinity;
      const footerCs = footer ? getComputedStyle(footer) : null;
      const footerRightEdge = footer
        ? footer.getBoundingClientRect().right - (parseFloat(footerCs.paddingRight) || 0)
        : Infinity;
      const flCs = getComputedStyle(footerLeft);
      const flClipRight = flCs.overflowX !== 'visible' ? footerLeft.getBoundingClientRect().right + 1 : Infinity;
      const minRightBound = Math.min(rightMinLeft, footerRightEdge, flClipRight);

      let nativeMaxRight = -Infinity;
      let anySvgClipped = false;
      for (const c of nativeChildren) {
        const info = getNativeVisualInfo(c);
        if (info.maxR > nativeMaxRight) nativeMaxRight = info.maxR;
        if (info.svgClipped) anySvgClipped = true;
      }

      const fitsRight =
        rootRect.right <= rightMinLeft - 4 &&
        rootRect.right <= footerRightEdge + 1 &&
        rootRect.right <= flClipRight;
      const fitsLeft = nativeMaxRight === -Infinity || rootRect.left >= nativeMaxRight + 1;
      const crowdedModel = !mode.compress && minRightBound - rootRect.right < 24 && isNativeSqueezed();
      if (fitsRight && fitsLeft && !(mode.compress && anySvgClipped) && !crowdedModel) break;
    }
    } finally {
      root._adjustingLayout = false;
    }
  };
  root._adjustLayout = () => {
    adjustLayout();
    root._layoutPopovers();
  };
  root._scheduleLayout = () => {
    if (root._layoutRaf) return;
    root._layoutRaf = requestAnimationFrame(() => {
      root._layoutRaf = 0;
      if (root.isConnected) root._adjustLayout();
    });
  };

  if (root._observedFooterLeft !== footerLeft) {
    if (root._modelObserver) root._modelObserver.disconnect();
    if (root._resizeObserver) root._resizeObserver.disconnect();
    root._observedFooterLeft = footerLeft;

    const obs = new MutationObserver((mutations) => {
      if (mutations.every((m) => root.contains(m.target))) return;
      const lateLegacy = document.getElementById('deck-metrics-strip');
      if (lateLegacy) {
        release(lateLegacy);
        lateLegacy.remove();
        if (globalThis.__agyCapsuleDeck) window.__deckOwnerTs = globalThis.__agyCapsuleDeck.owner;
      }
      if (root._applyModelQuota) root._applyModelQuota();
      root._scheduleLayout?.();
    });
    obs.observe(footerLeft, { subtree: true, characterData: true, childList: true });
    root._modelObserver = obs;

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        root._scheduleLayout?.();
      });
      if (footerLeft.parentElement) ro.observe(footerLeft.parentElement);
      ro.observe(footerLeft);
      root._resizeObserver = ro;
    }
  }

  motion('speed', pillSpeed, text => { speedValue.textContent = text.trim(); });
  motion('error', root.querySelector('[data-el="grpError"]'));

  root._fitPanelHeights = () => {
    // Only visible capsules participate in matched panel height.
    const errorPop = root.querySelector('.dk-error-pop');
    const pops = [root.querySelector('.dk-ctx-pop')];
    if (!quotaPop.closest('.dk-grp').hidden) pops.push(quotaPop);
    else quotaPop.style.height = '';
    if (errorPop && !errorPop.closest('.dk-grp').hidden) pops.push(errorPop);
    else if (errorPop) errorPop.style.height = '';
    if (root.dataset.panelLayout !== 'matched') {
      for (const pop of pops) pop.style.height = '';
      root._heightKey = '';
      return;
    }
    const key = JSON.stringify(d.prefs) + pops.map(pop => pop.textContent).join('|') + root.style.getPropertyValue('--dk-pop-max-width');
    if (key === root._heightKey) return;
    const previous = pops.map(pop => ({ display: pop.style.display, visibility: pop.style.visibility }));
    root.dataset.panelLayout = 'natural';
    for (const pop of pops) { pop.style.height = ''; pop.style.display = 'block'; pop.style.visibility = 'hidden'; }
    const heights = pops.map(pop => parseFloat(getComputedStyle(pop).height) || pop.getBoundingClientRect().height);
    root.dataset.panelLayout = 'matched';
    for (const [index, pop] of pops.entries()) {
      pop.style.display = previous[index].display;
      pop.style.visibility = previous[index].visibility;
      if (heights.every(height => height > 0)) pop.style.height = Math.max(...heights) + 'px';
    }
    if (heights.every(height => height > 0)) root._heightKey = key;
  };
  root._adjustLayout();

  return 'ok:' + modelText;
}

function toView(d) {
  const bd = contextBreakdown(d);
  const cache = cacheView(d, d.prefs);
  const {
    status: cacheStatus, hitPct: cacheHitPct, age: cacheAge,
    valDeco: cacheValDeco, valOp: cacheValOp, text: valCacheHit,
    countdown: valCacheHitK, ctxIconColor,
  } = cache;

  const groups = d.quotaGroups || [];
  let quotaSummaryGroups;
  let quotaHtml;
  if (groups.length === 0) {
    quotaSummaryGroups = [];
    quotaHtml = '<div class="dk-panel-content"></div>';
  } else {
    const isBar = appearance(d.prefs).quotaIndicator === 'bar';
    const windowOrder = { '5h': 0, weekly: 1 };
    const keyParts = [isBar ? 'bar' : 'ring'];
    for (const g of groups) {
      keyParts.push(String(g.displayName || ''), String(g.description || ''));
      for (const b of g.buckets || []) {
        keyParts.push(String(b.window || ''), String(b.displayName || ''), String(b.remainingFraction ?? ''), String(b.resetTime || ''), formatReset(b.resetTime, d.prefs));
      }
    }
    const qKey = keyParts.join('\x1f');
    const memo = toView._qMemo || (toView._qMemo = { key: '', summary: [], html: '' });
    if (memo.key === qKey) {
      quotaSummaryGroups = memo.summary;
      quotaHtml = memo.html;
    } else {
      quotaSummaryGroups = [];
      quotaHtml = '<div class="dk-panel-content">';
      for (const g of groups) {
        const rawName = String(g.displayName || '').trim().toLowerCase();
        const title = formatGroupTitle(g.displayName);
        const descMatch = String(g.description || '').match(/models within this group:\s*([^\n.]+)/i);
        const modelsInGroup = descMatch ? descMatch[1].toLowerCase() : '';
        let q5h = '--%';
        let qWk = '--%';
        const activeColor = activeGroupColor(g.buckets, 'var(--agc-muted)');
        quotaHtml += '<div class="dk-q-group" data-pool="' + escapeHtml(rawName) + '">';
        quotaHtml += '<div class="dk-q-title-row"><span class="dk-q-title">' + escapeHtml(title) + '</span><span class="dk-q-active"><span class="dk-q-active-dot" style="background:' + activeColor + '" aria-hidden="true"></span><span data-i18n="active">Active</span></span></div>';
        const buckets = [...(g.buckets || [])].sort((a, b) => (windowOrder[a.window] ?? 2) - (windowOrder[b.window] ?? 2));
        for (const b of buckets) {
          const baseLabel = formatBucketLabel(b);
          const resetShort = formatReset(b.resetTime, d.prefs);
          const pctLeft = Math.round((b.remainingFraction || 0) * 100);
          const pctStr = pctLeft + '%';
          if (b.window === '5h') q5h = pctStr;
          if (b.window === 'weekly') qWk = pctStr;
          const rowTone = pctLeft <= 10 ? ' data-tone="danger"' : pctLeft <= 25 ? ' data-tone="warn"' : '';
          quotaHtml += '<div class="dk-q-row"' + rowTone + ' data-quota-tooltip="' + escapeHtml(JSON.stringify({ pool: title, window: b.window, displayName: b.displayName, remainingFraction: b.remainingFraction, resetTime: b.resetTime })) + '">';
          const labelKey = b.window === 'weekly' ? 'weekly' : b.window === '5h' ? 'fiveHours' : '';
          const color = quotaColor(pctLeft / 100);
          const indicator = isBar
            ? '<span class="dk-q-meter"><span style="width:' + Math.max(0, Math.min(100, pctLeft)) + '%;background:' + color + '"></span></span>'
            : makeRingSvg(b.remainingFraction, 16);
          quotaHtml += '<span class="dk-q-label"' + (labelKey ? ' data-i18n="' + labelKey + '"' : '') + '>' + escapeHtml(baseLabel) + '</span>';
          quotaHtml += '<span class="dk-q-right">' + indicator + '<span class="dk-q-pct notranslate" translate="no">' + pctLeft + '%</span></span>';
          quotaHtml += '<span class="dk-q-mid notranslate" translate="no">' + escapeHtml(resetShort) + '</span></div>';
        }
        quotaHtml += '</div>';
        quotaSummaryGroups.push({ title, rawName, modelsInGroup, q5h, qWk });
      }
      quotaHtml += '</div>';
      memo.key = qKey;
      memo.summary = quotaSummaryGroups;
      memo.html = quotaHtml;
    }
  }

  return {
    prefs: d.prefs || { language: 'en' },
    generation: d.generation || null,
    turnSpeed: d.turnSpeed || null,
    turnMetrics: d.turnMetrics || null,
    requestError: d.requestError || { kind: 'none' },
    cloudPaygo: d.cloudPaygo === true,
    cache: { contextTokens: bd.ctx, cachedIn: bd.cached, lastStepEpochMs: d.lastStepEpochMs || 0 },
    contextData: { contextTokens: bd.ctx, maxContextTokens: bd.maxCtx, cachedIn: bd.cached, uncachedIn: d.uncachedIn, turn0Tokens: bd.turn0, totalOutputTokens: bd.out, totalThinkingTokens: bd.think },
    pillCtx: bd.pillCtx,
    ctxIconColor,
    usedFrac: bd.usedFrac,
    segReadW: bd.segReadW,
    segOutW: bd.segOutW,
    segThinkW: bd.segThinkW,
    segTurn0W: bd.segTurn0W,
    cacheStatus,
    cacheHitPct,
    cacheAge,
    cacheValDeco,
    cacheValOp,
    valCacheHit,
    valCacheHitK,
    valTurn0Pct: bd.turn0Pct,
    valTurn0K: bd.turn0K,
    valReadPct: bd.readPct,
    valReadK: bd.readK,
    valThinkPct: bd.thinkPct,
    valThinkK: bd.thinkK,
    valOutPct: bd.outPct,
    valOutK: bd.outK,
    quotaSummaryGroups,
    quotaHtml,
    instanceTs: INSTANCE_TS,
  };
}

// Installed once in each renderer. Clocks/layout keep updating without a CDP
// payload, and navigation clears old data before the next server snapshot.
function installRuntime(owner, hash) {
  const previous = globalThis.__agyCapsuleDeck;
  if (previous?.owner > owner) return 'superseded';
  previous?.dispose();
  window.__deckOwnerTs = owner;
  let data = null;
  let dataPath = '';
  let disposed = false;
  const run = () => {
    if (disposed || !data) return;
    if (globalThis.__agyCapsuleDeck !== api) return;
    if (location.pathname !== dataPath) {
      window.__agyCapsuleCleanup?.();
      return;
    }
    // Installed runtimes own the page; one-off legacy mounts must not strand
    // this runtime behind a newer timestamp while leaving two visible strips.
    window.__deckOwnerTs = owner;
    pageMount(toView(data));
  };
  const timer = setInterval(run, 1000);
  const api = {
    owner, hash,
    readState(caller) {
      if (caller < owner) return 'superseded';
      return { owner, hash, path: location.pathname, hasFooter: !!document.querySelector('.agy-composer-footer > div:first-child') };
    },
    apply(next, path, caller) {
      if (caller < owner) return 'superseded';
      if (caller !== owner || disposed || path !== location.pathname) return false;
      data = next;
      dataPath = path;
      run();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      if (globalThis.__agyCapsuleDeck === api) {
        window.__agyCapsuleCleanup?.();
        delete globalThis.__agyCapsuleDeck;
      }
    },
  };
  globalThis.__agyCapsuleDeck = api;
  return true;
}

export function buildRuntimeBundle(owner = INSTANCE_TS) {
  const functions = [detectHostTheme, toView, pageMount, installRuntime].map(fn => fn.toString()).join('\n');
  const source = DECK_SKIN_CSS + '\n' + getPresentationScript() + '\n' + functions;
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const code = `(()=>{const INSTANCE_TS=${Number(owner)};const DECK_SKIN_CSS=${JSON.stringify(DECK_SKIN_CSS)};if(globalThis.__agyCapsuleDeck?.owner>INSTANCE_TS)return 'superseded';${getPresentationScript()}\nconst {escapeHtml,appearance,formatReset,cacheView,quotaColor,makeRingSvg,formatGroupTitle,formatBucketLabel,activeGroupColor,contextBreakdown}=globalThis.__agyCapsulePresentation;\n${functions}\nreturn installRuntime(INSTANCE_TS,${JSON.stringify(hash)});})()`;
  return { code, hash };
}

export { pageMount, toView, detectHostTheme };

export function startDeckInjector(inspect, options = {}) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const bundle = buildRuntimeBundle(owner);
  const sockets = new Map();
  let cachedPages = [];
  let lastListAt = 0;
  let lastErr = '';
  let stopped = false;
  let busy = false;
  // 'unknown' until the first lookup; the sidebar explains 'missing' / 'unreachable'.
  let cdpState = 'unknown';
  const logOnce = message => {
    if (lastErr !== message) { lastErr = message; console.error('[deck]', message); }
  };
  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const callback of entry.pending.values()) callback(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };
  const connect = async target => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastPayload: '', lastPath: '' };
    await new Promise((resolve, reject) => {
      const fail = message => { clearTimeout(timer); retire(entry, target.id); reject(new Error(message)); };
      const timer = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) { retire(entry, target.id); throw new Error('injector stopped'); }
    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        const callback = entry.pending.get(message.id);
        if (callback) { entry.pending.delete(message.id); callback(message); }
      } catch {}
    };
    ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    return entry;
  };
  const evaluate = (entry, expression) => new Promise(resolve => {
    if (entry.ws.readyState !== 1) return resolve(undefined);
    const id = entry.nextId++;
    const timer = setTimeout(() => { entry.pending.delete(id); resolve(undefined); }, 3000);
    entry.pending.set(id, message => { clearTimeout(timer); resolve(message?.result?.result?.value); });
    try { entry.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
    catch { clearTimeout(timer); entry.pending.delete(id); resolve(undefined); }
  });
  const pages = async () => {
    if (cachedPages.length && Date.now() - lastListAt < 4000) return cachedPages;
    let port;
    try { port = readFileSync(options.portFile || PORT_FILE, 'utf8').split(/\r?\n/)[0].trim(); }
    catch { cdpState = 'missing'; logOnce('DevToolsActivePort not found'); return []; }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const targets = await response.json();
      cachedPages = targets.filter(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(t.url || '') && t.webSocketDebuggerUrl);
      lastListAt = Date.now();
      cdpState = 'ok';
      const ids = new Set(cachedPages.map(t => t.id));
      for (const [id, entry] of sockets) if (!ids.has(id)) retire(entry, id);
      return cachedPages;
    } catch (error) { cdpState = 'unreachable'; logOnce('CDP list failed: ' + error.message); return []; }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all([...sockets].map(async ([id, entry]) => {
      try { await evaluate(entry, `globalThis.__agyCapsuleDeck?.owner===${owner}&&globalThis.__agyCapsuleDeck.dispose()`); }
      finally { retire(entry, id); }
    }));
  };
  const supersede = async () => {
    await stop();
    (options.onSuperseded || (() => process.exit(0)))();
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const target of await pages()) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || await connect(target);
          let state = await evaluate(entry, `globalThis.__agyCapsuleDeck?.readState(${owner})??null`);
          if (state === undefined || stopped) continue;
          if (state === 'superseded') return await supersede();
          if (state?.owner !== owner || state.hash !== bundle.hash) {
            const installed = await evaluate(entry, bundle.code);
            if (installed === 'superseded') return await supersede();
            if (!installed || stopped) continue;
            entry.lastPayload = '';
            state = await evaluate(entry, `globalThis.__agyCapsuleDeck?.readState(${owner})??null`);
          }
          if (state === 'superseded') return await supersede();
          if (state?.owner !== owner || !state.path || state.hasFooter === false) continue;
          const match = state.path.match(/\/c\/([0-9a-f-]{36})/);
          const data = await inspect(match ? match[1] : '', true);
          if (!data || data.error || stopped) continue;
          const payload = JSON.stringify(data);
          if (entry.lastPayload !== payload || entry.lastPath !== state.path) {
            const applied = await evaluate(entry, `globalThis.__agyCapsuleDeck?.apply(${payload},${JSON.stringify(state.path)},${owner})??false`);
            if (applied === 'superseded') return await supersede();
            if (applied) { entry.lastPayload = payload; entry.lastPath = state.path; }
            else entry.lastPayload = '';
          }
          lastErr = '';
        } catch (error) {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
          logOnce('page ' + target.id + ': ' + error.message);
        }
      }
    } finally { busy = false; }
  };
  const timer = setInterval(tick, INTERVAL_MS);
  console.log('[deck] injector started, port file:', options.portFile || PORT_FILE);
  return { tick, stop, status: () => cdpState };
}
