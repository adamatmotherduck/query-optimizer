import { useState, useCallback, useEffect, useMemo } from 'react';
import { analyze } from './analyzer';
import type { AnalysisResult } from './analyzer';
import SqlEditor from './components/SqlEditor';
import HighlightedSql from './components/HighlightedSql';
import FindingsPanel from './components/FindingsPanel';
import ThemeToggle from './components/ThemeToggle';
import { getStoredTheme, storeTheme, resolveTheme, applyTheme, getCopy } from './theme';
import type { ThemeMode } from './theme';
import './App.css';

const EXAMPLE_QUERIES = [
  {
    label: 'SELECT * from large table',
    sql: `SELECT *
FROM orders
JOIN customers ON orders.customer_id = customers.id
ORDER BY orders.created_at;`,
  },
  {
    label: 'Correlated subquery',
    sql: `SELECT
  o.id,
  o.total,
  (SELECT MAX(amount) FROM payments p WHERE p.order_id = o.id) as max_payment
FROM orders o
WHERE o.status NOT IN (SELECT status FROM archived_statuses);`,
  },
  {
    label: 'Cross join + function in WHERE',
    sql: `SELECT a.name, b.category
FROM products a
CROSS JOIN categories b
WHERE UPPER(a.name) LIKE '%WIDGET%'
  AND YEAR(a.created_at) = 2024;`,
  },
  {
    label: 'Window function opportunity',
    sql: `SELECT * FROM (
  SELECT
    user_id,
    event_name,
    created_at,
    ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
  FROM events
) sub
WHERE rn = 1
ORDER BY created_at;`,
  },
  {
    label: 'Remote file anti-pattern',
    sql: `SELECT *
FROM read_parquet('https://example.com/data/events.parquet')
WHERE event_type = 'purchase'
UNION
SELECT *
FROM read_parquet('https://example.com/data/events_archive.parquet')
WHERE event_type = 'purchase';`,
  },
  {
    label: 'Heavy JSON + OOM risk',
    sql: `WITH parsed AS (
  SELECT
    payload->>'name' AS name,
    payload->>'email' AS email,
    (payload->'score')::INTEGER AS score,
    (payload->'active')::BOOLEAN AS active,
    observed_at
  FROM events
),
latest AS (
  SELECT * FROM parsed
  ORDER BY observed_at DESC
  LIMIT 1
),
by_name AS (
  SELECT
    name,
    LIST(DISTINCT email ORDER BY email) AS emails,
    COUNT(DISTINCT score) AS unique_scores,
    list_transform(
      json_extract_string(payload, '$.tags[*]'),
      t -> UPPER(t)
    ) AS tags
  FROM events, json_each(events.payload->'items') AS je
  GROUP BY name
),
ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY name ORDER BY score DESC) AS rn
  FROM parsed
)
SELECT latest.*, by_name.*, ranked.*
FROM latest
CROSS JOIN by_name
LEFT JOIN ranked ON TRUE
WHERE rn = 1
ORDER BY name;`,
  },
  {
    label: 'PIVOT (non-spillable)',
    sql: `WITH status_raw AS (
  SELECT
    item_id,
    recorded_date,
    CASE
      WHEN status_code LIKE 'ERR_%' THEN 'ERR'
      WHEN status_code LIKE 'WARN_%' THEN 'WARN'
      ELSE status_code
    END AS status_code
  FROM warehouse.analytics.daily_status_snapshots
  WHERE recorded_date > '2024-08-01'
),
statuses AS (
  SELECT item_id, recorded_date, status_code
  FROM status_raw
  WHERE status_code IN ('OK', 'ERR', 'WARN', 'PENDING',
    'REVIEW', 'BLOCKED', 'ACTIVE', 'EXPIRED',
    'RETRY', 'SKIPPED', 'TIMEOUT', 'DONE')
),
statuses_pivoted AS (
  PIVOT statuses
  ON status_code
  USING count(*)
)
SELECT *
FROM statuses_pivoted;`,
  },
];

function App() {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [focusedRuleId, setFocusedRuleId] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);

  const resolved = useMemo(() => resolveTheme(themeMode), [themeMode]);
  const copy = useMemo(() => getCopy(resolved), [resolved]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (themeMode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyTheme(resolveTheme('system'));
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [themeMode]);

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    storeTheme(mode);
  }, []);

  const handleAnalyze = useCallback(() => {
    if (!sql.trim()) return;
    const r = analyze(sql);
    setResult(r);
  }, [sql]);

  const handleExample = useCallback((query: string) => {
    setSql(query);
    setResult(null);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        handleAnalyze();
      }
    },
    [handleAnalyze],
  );

  const hasFindings = result && result.findings.length > 0;
  const isClean = result && result.findings.length === 0 && !result.parseError;

  return (
    <div className="app" onKeyDown={handleKeyDown}>
      <header className="app-header">
        <div className="logo-area">
          <svg viewBox="0 0 32 32" width="32" height="32" className="logo-icon">
            <circle cx="16" cy="16" r="14" fill="#f9b72b" />
            <text x="16" y="21" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#1a1a2e">
              MD
            </text>
          </svg>
          <div>
            <h1>{copy.title}</h1>
            <p className="subtitle">{copy.subtitle}</p>
          </div>
        </div>
        <ThemeToggle mode={themeMode} onChange={handleThemeChange} />
      </header>

      <main className="app-main">
        <section className="input-section">
          <div className="section-header">
            <h2>SQL Query</h2>
            <span className="hint">Ctrl/Cmd + Enter to analyze</span>
          </div>
          <SqlEditor value={sql} onChange={setSql} />
          <div className="action-row">
            <button className="analyze-btn" onClick={handleAnalyze} disabled={!sql.trim()}>
              {copy.analyzeButton}
            </button>
            <div className="examples-dropdown">
              <span className="examples-label">{copy.examplesLabel}</span>
              {EXAMPLE_QUERIES.map((eq, i) => (
                <button key={i} className="example-btn" onClick={() => handleExample(eq.sql)}>
                  {eq.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {result && (
          <section className="results-section">
            {result.parseError && (
              <div className="parse-warning">
                <strong>Parse note:</strong> {result.parseError}
                <br />
                <span className="parse-warning-sub">
                  Pattern-based analysis was still performed. Some AST-based checks may be missing.
                </span>
              </div>
            )}

            {isClean && (
              <div className="clean-result">
                <span className="clean-icon">{'\u2713'}</span>
                <div>
                  <strong>{copy.cleanTitle}</strong>
                  <p>{copy.cleanMessage}</p>
                </div>
              </div>
            )}

            {hasFindings && (
              <>
                <div className="section-header">
                  <h2>Highlighted Query</h2>
                  <span className="hint">{copy.hoverHint}</span>
                </div>
                <HighlightedSql
                  sql={sql}
                  findings={result.findings}
                  focusedRuleId={focusedRuleId}
                  onFocusHandled={() => setFocusedRuleId(null)}
                />
                <FindingsPanel
                  findings={result.findings}
                  onFindingClick={(ruleId) => setFocusedRuleId(ruleId)}
                />
              </>
            )}
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>{copy.footer}</p>
      </footer>
    </div>
  );
}

export default App;
