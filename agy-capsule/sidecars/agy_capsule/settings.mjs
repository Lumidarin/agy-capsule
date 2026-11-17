import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({ language: 'en', settingsLanguage: 'zh-CN', panelLayout: 'natural', density: 'compact', quotaIndicator: 'ring', labelCase: 'lowercase', resetFormat: 'compact', contextLayout: 'columns', turnLayout: 'columns', contextMarker: 'square', turnMarker: 'square', showContextBreakdown: true, columnLabel: true, columnValue: true, columnPercent: false, columnOrder: 'label,value,percent', highlightActiveModel: false, hideUnavailableQuota: false, showCacheWarnings: true, showContextWarnings: true, showRequestErrors: true, showSpeed: true, speedAnimation: false, showRequestMetrics: true, showTurnMetrics: true });
const choices = {
  language: ['en', 'zh-CN', 'zh-TW'],
  settingsLanguage: ['en', 'zh-CN', 'zh-TW'],
  panelLayout: ['natural', 'matched'],
  density: ['compact', 'standard', 'spacious'],
  quotaIndicator: ['ring', 'bar'],
  labelCase: ['lowercase', 'titlecase'],
  resetFormat: ['compact', 'localized'],
  contextLayout: ['columns', 'rows'],
  turnLayout: ['columns', 'rows'],
  contextMarker: ['square', 'dot'],
  turnMarker: ['square', 'dot'],
  showContextBreakdown: [true, false],
  columnLabel: [true, false],
  columnValue: [true, false],
  columnPercent: [true, false],
  columnOrder: ['label,value,percent', 'label,percent,value', 'value,label,percent', 'value,percent,label', 'percent,label,value', 'percent,value,label'],
  highlightActiveModel: [true, false],
  hideUnavailableQuota: [true, false],
  showCacheWarnings: [true, false],
  showContextWarnings: [true, false],
  showRequestErrors: [true, false],
  showSpeed: [true, false],
  speedAnimation: [true, false],
  showRequestMetrics: [true, false],
  showTurnMetrics: [true, false],
};

export function validateSettings(raw) {
  return Object.fromEntries(Object.entries(choices).filter(([key, values]) => values.includes(raw?.[key])).map(([key]) => [key, raw[key]]));
}

export function normalizeSettings(raw = {}) {
  const valid = validateSettings(raw);
  const legacyReqKeys = ['showRequestSpeed', 'showOutput', 'showTtft', 'showTotalTime'];
  const hasLegacyReq = legacyReqKeys.some(key => typeof raw?.[key] === 'boolean');
  const migrated = typeof raw?.showRequestMetrics === 'boolean' ? {}
    : hasLegacyReq ? { showRequestMetrics: legacyReqKeys.some(key => raw?.[key] === true) }
    : typeof raw?.showGenerationDetails === 'boolean' ? { showRequestMetrics: raw.showGenerationDetails } : {};
  // Read old style-only settings once without restoring a selectable preset.
  const legacyStyle = raw?.panelStyle === 'modern' ? { density: 'standard', quotaIndicator: 'bar' } : {};
  const next = { ...DEFAULT_SETTINGS, ...legacyStyle, ...migrated, ...valid };
  if (next.showSpeed === false) next.speedAnimation = false;
  return next;
}

export function createSettingsStore(filePath = join(homedir(), '.gemini', 'config', 'agy-capsule', 'settings.json')) {
  let cached = { ...DEFAULT_SETTINGS };
  let lastStat = '';
  function read() {
    try {
      const stat = statSync(filePath);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (key !== lastStat) {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        cached = normalizeSettings(raw);
        lastStat = key;
      }
    } catch {
      cached = { ...DEFAULT_SETTINGS };
      lastStat = '';
    }
    return { ...cached };
  }
  function update(patch) {
    const valid = validateSettings(patch);
    const next = normalizeSettings({ ...read(), ...valid });
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
    lastStat = '';
    return read();
  }
  return { read, update };
}
