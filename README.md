# MotherDuck Query Optimizer

A client-side SQL analyzer that detects performance, memory, network, and best-practice issues in DuckDB and MotherDuck queries. Paste a query, get actionable findings instantly — no data leaves your browser.

**Live:** [adamatmotherduck.github.io/query-optimizer](https://adamatmotherduck.github.io/query-optimizer/)

## How it works

1. SQL is parsed into an AST using a DuckDB-dialect SQL parser
2. AST-based rules detect structural issues (SELECT *, missing JOIN conditions, cross joins, deep nesting)
3. Regex-based rules catch DuckDB/MotherDuck-specific anti-patterns (non-spillable operators, remote file access, etc.)
4. Findings are displayed with severity, explanations, and concrete suggestions

Everything runs in the browser — no backend, no telemetry.

## Rules (40 total)

### AST-based rules

| Rule | Severity | Category |
|------|----------|----------|
| `select-star` | warning | performance |
| `order-without-limit` | warning | memory |
| `cross-join` | warning | memory |
| `deeply-nested-subquery` | warning | performance |
| `implicit-cross-join` | error | memory |
| `join-without-on` | warning | performance |

### Regex-based rules

**Memory / OOM**

| Rule | Severity | What it detects |
|------|----------|-----------------|
| `non-spillable-list` | error | `LIST()` aggregate (cannot spill to disk) |
| `non-spillable-list-distinct` | error | `LIST(DISTINCT ...)` double memory pressure |
| `non-spillable-string-agg` | warning | `STRING_AGG()` (cannot spill) |
| `non-spillable-ordered-agg` | warning | Aggregates with ORDER BY inside |
| `non-spillable-median` | warning | `MEDIAN()`, `QUANTILE()`, `PERCENTILE_CONT/DISC()`, `MODE()` |
| `non-spillable-pivot` | error | `PIVOT` (uses `LIST()` internally) |
| `many-blocking-operators` | warning/error | 5+ or 8+ blocking operators in one query |
| `unnest-large-expansion` | warning | `UNNEST()` on columns — row count explosion |
| `recursive-cte-no-limit` | warning | `WITH RECURSIVE` without termination guard |
| `ctas-memory` | info | `CREATE TABLE AS SELECT` materializes fully |
| `distinct-star` | warning | `SELECT DISTINCT *` |
| `count-distinct` | info | `COUNT(DISTINCT ...)` hash set in memory |
| `insert-select-star` | info | `INSERT INTO ... SELECT *` preserves order |
| `many-ctes` | info/warning | 5+ or 10+ CTEs held in memory |
| `list-transform` | info | `list_transform()` in-memory processing |
| `md-duckling-size` | info | OOM keyword detected |

**Performance**

| Rule | Severity | What it detects |
|------|----------|-----------------|
| `leading-wildcard-like` | warning | `LIKE '%...'` prevents index/zone map use |
| `function-on-filter-column` | warning | Function wrapping column in WHERE |
| `repeated-order-limit-1` | warning | `ORDER BY ... LIMIT 1` repeated (use `arg_max`) |
| `use-arg-max` | info | `ROW_NUMBER()` filtered to 1 (use `arg_max`) |
| `not-in-subquery` | warning | `NOT IN (SELECT ...)` NULL semantics trap |
| `correlated-subquery` | error | Correlated subquery re-executes per row |
| `large-in-list` | warning | `IN (...)` with 50+ literal values |
| `glob-many-files` | info | `**` glob on remote files |
| `temporal-join-via-window` | info | Inequality join + window (use `ASOF JOIN`) |
| `chained-select-star` | info | `SELECT *` through 2+ CTEs defeats column pruning |

**Network**

| Rule | Severity | What it detects |
|------|----------|-----------------|
| `remote-file-select-star` | error | `SELECT *` from remote file |
| `md-local-remote-transfer` | warning | Local file join with MotherDuck cloud table |
| `read-remote-no-filter` | warning | Remote file scan without WHERE |
| `multiple-remote-scans` | warning | 2+ remote file reads in one query |
| `md-cross-database-join` | info | Join across different database prefixes |

**Best practice**

| Rule | Severity | What it detects |
|------|----------|-----------------|
| `union-without-all` | info | `UNION` without `ALL` |
| `window-without-qualify` | info | Window function filtered in WHERE instead of QUALIFY |
| `group-by-verbose` | info | Verbose GROUP BY (use `GROUP BY ALL`) |
| `many-left-join-on-true` | info | 5+ `LEFT JOIN ... ON TRUE` |
| `or-chain-instead-of-in` | info | 4+ ORs on same column (use `IN`) |
| `between-timestamp` | info | `BETWEEN` on temporal columns (closed interval) |

**Schema**

| Rule | Severity | What it detects |
|------|----------|-----------------|
| `excessive-casts` | info | 8+ type casts (store as native types) |
| `heavy-json-extraction` | warning | 20+ JSON extractions |
| `moderate-json-extraction` | info | 8+ JSON extractions |
| `json-each-expansion` | warning | `json_each()` row expansion |
| `json-array-extract` | info | JSON array wildcard `[*]` extraction |

## Development

```bash
npm install
npm run dev       # start dev server at localhost:5173
npm run build     # typecheck + production build
npm run lint      # eslint
```

## Architecture

```
src/
  analyzer/
    types.ts        # Finding, AnalysisResult, Severity types
    rules.ts        # All 40 rules (AST + regex)
    index.ts        # analyze() entry point, parser setup
  components/
    SqlEditor.tsx   # Textarea input
    HighlightedSql.tsx  # SQL with finding highlights
    FindingsPanel.tsx   # Findings list with severity badges
    ThemeToggle.tsx     # Light/dark/system theme
  App.tsx           # Main app with example queries
  theme.ts          # Theme logic and copy
```

## Deployment

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`.
