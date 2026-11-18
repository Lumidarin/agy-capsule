// Standalone UI skin definitions: "native" (default upstream IDE host surface &
// palette) and "frosted" (opt-in smoked-glass vibrancy). Keep self-contained CSS
// strings so both the CDP shadow bundle and sidebar UI share one skin source.

export const UI_SKINS = Object.freeze(['native', 'frosted']);
export const DEFAULT_UI_SKIN = 'native';

export const DECK_SKIN_CSS = `
#deck-metrics-strip {
  --agc-fg: rgba(245, 245, 247, 0.88); --agc-fg-strong: #f5f5f7;
  --agc-muted: rgba(235, 235, 245, 0.56); --agc-subtle: rgba(235, 235, 245, 0.36);
  --agc-pill-hover: rgba(255, 255, 255, 0.065); --agc-pill-active: rgba(255, 255, 255, 0.095);
  --agc-card-top: rgba(32, 32, 36, 0.90); --agc-card-bg: rgba(22, 22, 26, 0.90);
  --agc-card-rim: rgba(255, 255, 255, 0.13); --agc-card-border: rgba(255, 255, 255, 0.085);
  --agc-card-shadow: 0 12px 30px -4px rgba(0, 0, 0, 0.50), 0 2px 6px rgba(0, 0, 0, 0.26);
  --agc-track: rgba(120, 120, 128, 0.24); --agc-track-ring: rgba(255, 255, 255, 0.06);
  --agc-seg-sheen: rgba(255, 255, 255, 0.16); --agc-ring-track: rgba(142, 142, 147, 0.26);
  --agc-dot-rim: rgba(255, 255, 255, 0.24); --agc-divider: rgba(255, 255, 255, 0.095);
  --agc-hairline-v: rgba(255, 255, 255, 0.12);
  --agc-good: #32d568; --agc-warn: #f5a524; --agc-danger: #ff4d45;
  --agc-c-turn0: #ef9b28; --agc-c-read: #2e90fa; --agc-c-think: #b668f0; --agc-c-out: #22c3a6;
  --agc-turn-line: color-mix(in srgb, var(--agc-muted) 50%, transparent);
  color: var(--agc-muted);
}
#deck-metrics-strip[data-theme="light"] {
  --agc-fg: rgba(28, 28, 30, 0.88); --agc-fg-strong: #1c1c1e;
  --agc-muted: rgba(60, 60, 67, 0.60); --agc-subtle: rgba(60, 60, 67, 0.40);
  --agc-pill-hover: rgba(0, 0, 0, 0.048); --agc-pill-active: rgba(0, 0, 0, 0.072);
  --agc-card-top: rgba(255, 255, 255, 0.93); --agc-card-bg: rgba(248, 249, 251, 0.90);
  --agc-card-rim: rgba(255, 255, 255, 0.98); --agc-card-border: rgba(0, 0, 0, 0.08);
  --agc-card-shadow: 0 10px 26px -4px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.05);
  --agc-track: rgba(120, 120, 128, 0.17); --agc-track-ring: rgba(0, 0, 0, 0.045);
  --agc-seg-sheen: rgba(255, 255, 255, 0.28); --agc-ring-track: rgba(120, 120, 128, 0.20);
  --agc-dot-rim: rgba(0, 0, 0, 0.08); --agc-divider: rgba(60, 60, 67, 0.11);
  --agc-hairline-v: rgba(60, 60, 67, 0.14);
  --agc-good: #24a148; --agc-warn: #d97706; --agc-danger: #e53935;
  --agc-c-turn0: #df850b; --agc-c-read: #1d7bf6; --agc-c-think: #9d4edd; --agc-c-out: #10a389;
}
#deck-metrics-strip[data-ui-skin="native"] {
  --agc-fg: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
  --agc-fg-strong: var(--foreground, #ebebeb);
  --agc-muted: var(--muted-foreground, #8e8e93);
  --agc-subtle: color-mix(in srgb, var(--muted-foreground, #8e8e93) 65%, transparent);
  --agc-pill-hover: var(--secondary, rgba(128, 128, 128, 0.12));
  --agc-pill-active: var(--secondary, rgba(128, 128, 128, 0.16));
  --agc-card-top: var(--card, rgba(20, 20, 22, 0.97)); --agc-card-bg: var(--card, rgba(20, 20, 22, 0.97));
  --agc-card-rim: transparent; --agc-card-border: var(--border, rgba(128, 128, 128, 0.18));
  --agc-card-shadow: 0 2px 8px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.03);
  --agc-track: rgba(142, 142, 147, 0.24); --agc-track-ring: transparent; --agc-seg-sheen: transparent;
  --agc-ring-track: rgba(142, 142, 147, 0.28); --agc-dot-rim: transparent;
  --agc-divider: var(--border, rgba(142, 142, 147, 0.24));
  --agc-hairline-v: var(--border, rgba(142, 142, 147, 0.24));
  --agc-good: light-dark(#16a34a, #4ea84e); --agc-warn: light-dark(#d97706, #d4940a); --agc-danger: light-dark(#dc2626, #e06c75);
  --agc-c-turn0: #d4940a; --agc-c-read: #388bfd; --agc-c-think: #00b386; --agc-c-out: #e86a24;
  --agc-turn-line: color-mix(in srgb, var(--agc-muted) 50%, transparent);
}
#deck-metrics-strip[data-ui-skin="native"][data-theme="light"] {
  --agc-fg: color-mix(in srgb, var(--foreground, #18181b) 88%, transparent);
  --agc-fg-strong: var(--foreground, #18181b);
  --agc-card-top: var(--card, rgba(255, 255, 255, 0.97)); --agc-card-bg: var(--card, rgba(255, 255, 255, 0.97));
}
#deck-metrics-strip[data-ui-skin="native"] .dk-pop {
  background: var(--agc-card-bg); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--border, rgba(128, 128, 128, 0.18)); border-radius: 10px; box-shadow: var(--agc-card-shadow);
}
#deck-metrics-strip[data-ui-skin="native"] .dk-divider { height: 1px; }
#deck-metrics-strip[data-ui-skin="native"] .dk-generation,
#deck-metrics-strip[data-ui-skin="native"] .dk-q-group + .dk-q-group,
#deck-metrics-strip[data-ui-skin="native"] .dk-error-diagnostic { border-top-width: 1px; }
#deck-metrics-strip[data-ui-skin="native"] .dk-track { background: rgba(142, 142, 147, 0.24); box-shadow: none; gap: 1.5px; }
#deck-metrics-strip[data-ui-skin="native"] .dk-seg { border-radius: 999px; background-image: none; }
#deck-metrics-strip[data-ui-skin="native"] .dk-q-meter { background: rgba(142, 142, 147, 0.24); box-shadow: none; }
#deck-metrics-strip[data-ui-skin="native"] .dk-q-meter > span { background-image: none; }
#deck-metrics-strip[data-ui-skin="native"] .dk-used-pct > [data-k="usedPctText"] { font-weight: 500; }
`;

export const SIDEBAR_SKIN_CSS = `
:root {
  color-scheme: light dark;
  --agc-fg: color-mix(in srgb, var(--foreground, #ebebeb) 88%, transparent);
  --agc-fg-strong: var(--foreground, #ebebeb);
  --agc-muted: var(--muted-foreground, #8e8e93);
  --agc-divider: color-mix(in srgb, var(--border, rgba(142, 142, 147, 0.24)) 72%, transparent);
  --agc-hover: color-mix(in srgb, var(--foreground, #ebebeb) 6.5%, transparent);
  --agc-good: light-dark(#24a148, #32d568);
  --agc-warn: light-dark(#d97706, #f5a524);
  --agc-danger: light-dark(#e53935, #ff4d45);
  --agc-accent: light-dark(#1d7bf6, #2e90fa);
  --agc-c-turn0: light-dark(#df850b, #ef9b28);
  --agc-c-read: light-dark(#1d7bf6, #2e90fa);
  --agc-c-think: light-dark(#9d4edd, #b668f0);
  --agc-c-out: light-dark(#10a389, #22c3a6);
  --agc-track: light-dark(rgba(120, 120, 128, 0.17), rgba(120, 120, 128, 0.24));
  --agc-track-ring: light-dark(rgba(0, 0, 0, 0.045), rgba(255, 255, 255, 0.06));
  --agc-seg-sheen: light-dark(rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.16));
  --agc-ring-track: light-dark(rgba(120, 120, 128, 0.20), rgba(142, 142, 147, 0.26));
  --agc-turn-line: color-mix(in srgb, var(--agc-muted) 50%, transparent);
}
body[data-ui-skin="native"] {
  --agc-divider: var(--border, rgba(142, 142, 147, 0.24));
  --agc-hover: color-mix(in srgb, var(--foreground, #ebebeb) 8%, transparent);
  --agc-track: rgba(142, 142, 147, 0.24); --agc-track-ring: transparent; --agc-seg-sheen: transparent;
  --agc-ring-track: rgba(142, 142, 147, 0.28);
  --agc-good: light-dark(#16a34a, #4ea84e); --agc-warn: light-dark(#d97706, #d4940a); --agc-danger: light-dark(#dc2626, #e06c75);
  --agc-accent: light-dark(#2563eb, #388bfd);
  --agc-c-turn0: #d4940a; --agc-c-read: #388bfd; --agc-c-think: #00b386; --agc-c-out: #e86a24;
}
body[data-ui-skin="native"] .progress-track { background: rgba(142, 142, 147, 0.24); box-shadow: none; gap: 1.5px; }
body[data-ui-skin="native"] .seg { border-radius: 999px; background-image: none; }
body[data-ui-skin="native"] .divider { height: 1px; }
body[data-ui-skin="native"] .generation-block,
body[data-ui-skin="native"] .stats-quota .quota-group + .quota-group,
body[data-ui-skin="native"] .setting-card,
body[data-ui-skin="native"] .settings-scope { border-top-width: 1px; }
body[data-ui-skin="native"] .quota-meter { background: rgba(142, 142, 147, 0.24); box-shadow: none; border-radius: 999px; }
body[data-ui-skin="native"] .quota-meter > span { background-image: none; }
body[data-ui-skin="native"] .setting-seg-opt[data-active="true"] { color: var(--agc-good); }
body[data-ui-skin="native"] .stats-context,
body[data-ui-skin="native"] .panel .quota-group,
body[data-ui-skin="native"] .pv-detail-card,
body[data-ui-skin="native"] .pv-swatch { border-width: 1px; }
body[data-ui-skin="native"] .metric-help { border-width: 1px; border-radius: 6px; box-shadow: 0 3px 12px #0003; }
`;
