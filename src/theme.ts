export type ThemeMode = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'md-optimizer-theme';

export function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  } catch { /* ignore */ }
  return 'system';
}

export function storeTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* ignore */ }
}

export function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
}

// --- Flavor text per theme ---

export interface ThemeCopy {
  title: string;
  subtitle: string;
  analyzeButton: string;
  cleanTitle: string;
  cleanMessage: string;
  footer: string;
  hoverHint: string;
  examplesLabel: string;
}

export const DARK_COPY: ThemeCopy = {
  title: 'Query Optimizer',
  subtitle: 'Enter, if you dare, and reveal the darkness lurking in your SQL',
  analyzeButton: 'Unleash the Analysis',
  cleanTitle: 'No curses detected',
  cleanMessage: 'Your query has survived the inspection. Not a single ghoul lurks within.',
  footer: 'All analysis is performed within your own crypt \u2014 no data escapes these walls.',
  hoverHint: 'Hover over the cursed fragments to learn their dark secrets',
  examplesLabel: 'Summon an example:',
};

export const LIGHT_COPY: ThemeCopy = {
  title: 'Query Optimizer',
  subtitle: 'A friendly helper for your DuckDB & MotherDuck queries \u2728',
  analyzeButton: 'Analyze Query',
  cleanTitle: 'Looking good!',
  cleanMessage: 'No issues found \u2014 your query is ready to fly!',
  footer: 'All analysis happens right here in your browser \u2014 no data sent anywhere!',
  hoverHint: 'Hover over highlighted bits for friendly suggestions',
  examplesLabel: 'Try an example:',
};

export function getCopy(resolved: 'dark' | 'light'): ThemeCopy {
  return resolved === 'dark' ? DARK_COPY : LIGHT_COPY;
}
