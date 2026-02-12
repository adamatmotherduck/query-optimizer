import type { Finding, Severity } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finding(
  ruleId: string,
  severity: Severity,
  title: string,
  message: string,
  suggestion: string,
  category: Finding['category'],
  fragment?: string,
): Finding {
  return { ruleId, severity, title, message, suggestion, category, fragment };
}

/** Case-insensitive position finder that returns { start, end } for the first occurrence of `needle`. */
function locate(sql: string, needle: string): { start: number; end: number } | undefined {
  const idx = sql.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return undefined;
  return { start: idx, end: idx + needle.length };
}

/** Find all occurrences of a regex in sql, return fragments */
function findAll(sql: string, re: RegExp): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = global.exec(sql)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

/** Count occurrences of a regex */
function countMatches(sql: string, re: RegExp): number {
  return findAll(sql, re).length;
}

// ---------------------------------------------------------------------------
// AST-based rules (run against the parsed AST from node-sql-parser)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AST = any;

function checkSelectStar(ast: AST, sql: string): Finding[] {
  const findings: Finding[] = [];
  if (ast.type !== 'select') return findings;

  const cols = ast.columns;
  if (cols === '*') {
    findings.push(
      finding(
        'select-star',
        'warning',
        'SELECT * detected',
        'SELECT * reads every column from the table. In columnar engines like DuckDB, this defeats column pruning and transfers unnecessary data — especially costly when reading remote Parquet files.',
        'List only the columns you need: SELECT col1, col2 FROM ... You can also use SELECT * EXCLUDE (col) to drop specific columns.',
        'performance',
        'SELECT *',
      ),
    );
    const loc = locate(sql, 'select *');
    if (loc) findings[findings.length - 1].offset = loc;
  } else if (Array.isArray(cols)) {
    for (const col of cols) {
      if (col.expr && col.expr.type === 'star') {
        findings.push(
          finding(
            'select-star',
            'warning',
            'SELECT * detected',
            'SELECT * reads every column. In columnar engines, only select the columns you need to take advantage of column pruning.',
            'List only the columns you need, or use EXCLUDE to drop unneeded columns.',
            'performance',
            '*',
          ),
        );
      }
    }
  }

  // Recurse into subqueries
  if (ast.from) {
    for (const fromItem of Array.isArray(ast.from) ? ast.from : [ast.from]) {
      if (fromItem.expr && fromItem.expr.ast) {
        findings.push(...checkSelectStar(fromItem.expr.ast, sql));
      }
    }
  }

  return findings;
}

function checkOrderByWithoutLimit(ast: AST, sql: string): Finding[] {
  const findings: Finding[] = [];
  if (ast.type !== 'select') return findings;

  if (ast.orderby && !ast.limit) {
    const frag = 'ORDER BY';
    findings.push(
      finding(
        'order-without-limit',
        'warning',
        'ORDER BY without LIMIT',
        'Sorting the entire result set requires materializing all rows in memory before returning. This is a pipeline breaker that can cause out-of-memory errors on large datasets.',
        'Add a LIMIT clause if you only need a subset, or remove ORDER BY if ordering is not required. For "top N" queries, use LIMIT N.',
        'memory',
        frag,
      ),
    );
    const loc = locate(sql, 'order by');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  return findings;
}

function checkCrossJoin(ast: AST, sql: string): Finding[] {
  const findings: Finding[] = [];
  if (ast.type !== 'select' || !ast.from) return findings;

  const fromList = Array.isArray(ast.from) ? ast.from : [ast.from];
  for (const item of fromList) {
    if (item.join === 'CROSS JOIN') {
      findings.push(
        finding(
          'cross-join',
          'warning',
          'CROSS JOIN detected',
          'A CROSS JOIN produces the Cartesian product of both tables (rows_a × rows_b). This is safe when one side is guaranteed to be a single row (e.g., a scalar CTE), but dangerous on large tables where it can explode memory usage.',
          'Verify that at least one side of the CROSS JOIN returns a single row. If joining large tables, replace with an INNER JOIN or LEFT JOIN with a proper ON condition.',
          'memory',
          'CROSS JOIN',
        ),
      );
      const loc = locate(sql, 'cross join');
      if (loc) findings[findings.length - 1].offset = loc;
    }
  }

  return findings;
}

function checkNestedSubqueries(ast: AST, _sql: string, depth = 0): Finding[] {
  const findings: Finding[] = [];
  if (ast.type !== 'select') return findings;

  if (depth >= 3) {
    findings.push(
      finding(
        'deeply-nested-subquery',
        'warning',
        'Deeply nested subquery',
        'Subqueries nested 3+ levels deep are hard to optimize. The query planner may not be able to flatten them, leading to repeated scans.',
        'Refactor using CTEs (WITH clauses). DuckDB can auto-materialize identical CTEs, improving readability and potentially performance.',
        'performance',
      ),
    );
  }

  // Check WHERE subqueries
  if (ast.where) {
    checkExprForSubqueries(ast.where, _sql, depth, findings);
  }

  // Check FROM subqueries
  if (ast.from) {
    for (const f of Array.isArray(ast.from) ? ast.from : [ast.from]) {
      if (f.expr?.ast) {
        findings.push(...checkNestedSubqueries(f.expr.ast, _sql, depth + 1));
      }
    }
  }

  return findings;
}

function checkExprForSubqueries(expr: AST, sql: string, depth: number, findings: Finding[]): void {
  if (!expr) return;
  if (expr.ast) {
    findings.push(...checkNestedSubqueries(expr.ast, sql, depth + 1));
  }
  if (expr.left) checkExprForSubqueries(expr.left, sql, depth, findings);
  if (expr.right) checkExprForSubqueries(expr.right, sql, depth, findings);
  if (expr.args?.expr) {
    const args = Array.isArray(expr.args.expr) ? expr.args.expr : [expr.args.expr];
    for (const a of args) {
      if (a.ast) findings.push(...checkNestedSubqueries(a.ast, sql, depth + 1));
    }
  }
}

function checkJoinWithoutCondition(ast: AST, sql: string): Finding[] {
  const findings: Finding[] = [];
  if (ast.type !== 'select' || !ast.from) return findings;

  const fromList = Array.isArray(ast.from) ? ast.from : [ast.from];

  // Multiple tables in FROM without any WHERE = implicit cross join
  if (fromList.length > 1) {
    const hasJoinKeyword = fromList.some((f: AST) => f.join);
    if (!hasJoinKeyword && !ast.where) {
      findings.push(
        finding(
          'implicit-cross-join',
          'error',
          'Implicit cross join (comma join without WHERE)',
          'Listing tables separated by commas without a WHERE clause creates a Cartesian product. This is equivalent to CROSS JOIN and can be extremely expensive.',
          'Use explicit JOIN syntax with ON conditions: FROM a JOIN b ON a.id = b.id',
          'memory',
          fromList.map((f: AST) => f.table || f.as || '').filter(Boolean).join(', '),
        ),
      );
    }
  }

  // Explicit JOIN without ON
  for (const item of fromList) {
    if (item.join && !['CROSS JOIN'].includes(item.join) && !item.on) {
      findings.push(
        finding(
          'join-without-on',
          'warning',
          'JOIN without ON condition',
          'A JOIN without an ON condition may produce a Cartesian product or rely on implicit behavior.',
          'Always specify an explicit ON condition for joins.',
          'performance',
          item.join,
        ),
      );
      const loc = locate(sql, item.join);
      if (loc) findings[findings.length - 1].offset = loc;
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Regex / text-based rules (for patterns harder to detect via AST)
// ---------------------------------------------------------------------------

function regexRules(sql: string): Finding[] {
  const findings: Finding[] = [];
  const upper = sql.toUpperCase();

  // =========================================================================
  // NON-SPILLABLE OPERATORS (critical for MotherDuck — Ducklings crash on OOM)
  // =========================================================================

  // 1. list() aggregate — CANNOT spill to disk
  const listAggMatches = findAll(sql, /\blist\s*\(/gi);
  const listDistinctMatches = findAll(sql, /\bLIST\s*\(\s*DISTINCT\b/gi);
  if (listAggMatches.length > 0) {
    const count = listAggMatches.length;
    findings.push(
      finding(
        'non-spillable-list',
        'error',
        `list() aggregate cannot spill to disk (${count}x)`,
        `The list() aggregate function is used ${count} time(s) in this query. Per DuckDB docs, list() cannot offload intermediate state to disk. On large datasets, this will cause out-of-memory crashes — especially on MotherDuck Ducklings with fixed memory limits.`,
        'Consider whether you can: (1) pre-filter data before aggregating with list(), (2) add a LIMIT or WHERE to reduce input rows, (3) use string_agg() if you only need a concatenated string (though it has the same spill limitation), or (4) break the query into smaller batches.',
        'memory',
        listAggMatches[0],
      ),
    );
    const loc = locate(sql, listAggMatches[0]);
    if (loc) findings[findings.length - 1].offset = loc;
  }
  if (listDistinctMatches.length > 0) {
    findings.push(
      finding(
        'non-spillable-list-distinct',
        'error',
        'LIST(DISTINCT ...) — double memory pressure',
        'LIST(DISTINCT ...) combines two non-spillable operations: deduplication and list accumulation. The DISTINCT requires a hash set in memory AND the resulting list is accumulated in memory. Neither can spill to disk.',
        'If you only need the distinct values as a comma-separated string, consider string_agg(DISTINCT ...) — though it also cannot spill. Better: reduce the input dataset first with a GROUP BY in a prior CTE.',
        'memory',
        listDistinctMatches[0],
      ),
    );
    const loc = locate(sql, listDistinctMatches[0]);
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 2. string_agg() — CANNOT spill to disk
  if (/\bstring_agg\s*\(/i.test(sql)) {
    findings.push(
      finding(
        'non-spillable-string-agg',
        'warning',
        'string_agg() cannot spill to disk',
        'The string_agg() function cannot offload intermediate state to disk. On large datasets with many groups or large string values, this can exhaust memory.',
        'Pre-filter or limit input data before applying string_agg(). Consider whether you actually need string concatenation or if an array (list) return is acceptable.',
        'memory',
        'string_agg(',
      ),
    );
    const loc = locate(sql, 'string_agg(');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 3. Aggregate with ORDER BY inside — holistic, cannot spill
  const aggOrderByMatches = findAll(sql, /\b(?:list|string_agg|array_agg|LIST)\s*\([^)]*ORDER\s+BY\b/gi);
  if (aggOrderByMatches.length > 0) {
    findings.push(
      finding(
        'non-spillable-ordered-agg',
        'warning',
        'Ordered aggregate (ORDER BY inside aggregate)',
        'Aggregate functions with an ORDER BY clause (e.g., LIST(... ORDER BY ...)) are "holistic" — they must see all input before producing output. DuckDB cannot spill these complex intermediate states to disk.',
        'If ordering within the aggregate is not critical, remove the ORDER BY. Otherwise, ensure the input dataset is small or pre-sorted.',
        'memory',
        aggOrderByMatches[0],
      ),
    );
    const loc = locate(sql, aggOrderByMatches[0]);
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // =========================================================================
  // MULTIPLE BLOCKING OPERATORS
  // =========================================================================

  // 4. Multiple blocking operators — combined memory pressure
  const orderByCount = countMatches(sql, /\bORDER\s+BY\b/gi);
  const windowFuncCount = countMatches(sql, /\bOVER\s*\(/gi);
  const groupByCount = countMatches(sql, /\bGROUP\s+BY\b/gi);
  const totalBlockingOps = orderByCount + windowFuncCount + groupByCount;

  if (totalBlockingOps >= 8) {
    findings.push(
      finding(
        'many-blocking-operators',
        'error',
        `${totalBlockingOps} blocking operators detected`,
        `This query contains ${orderByCount} ORDER BY, ${windowFuncCount} window function (OVER), and ${groupByCount} GROUP BY operations. Each is a blocking/pipeline-breaking operator that buffers data in memory. Per DuckDB docs: "If multiple blocking operators appear in the same query, DuckDB may still throw an out-of-memory exception due to the complex interplay of these operators."`,
        'Consider breaking this query into multiple sequential queries, materializing intermediate results into temp tables. This lets DuckDB release memory between steps rather than holding all intermediate states simultaneously.',
        'memory',
      ),
    );
  } else if (totalBlockingOps >= 5) {
    findings.push(
      finding(
        'many-blocking-operators',
        'warning',
        `${totalBlockingOps} blocking operators in one query`,
        `This query has ${orderByCount} ORDER BY, ${windowFuncCount} window functions, and ${groupByCount} GROUP BY operations. Each is a pipeline breaker that buffers data in memory. Combined, they increase the risk of out-of-memory errors.`,
        'Consider materializing intermediate CTEs into temp tables to reduce peak memory usage, or break the query into sequential steps.',
        'memory',
      ),
    );
  }

  // =========================================================================
  // JSON PROCESSING
  // =========================================================================

  // 5. Heavy JSON extraction — memory intensive
  const jsonArrowCount = countMatches(sql, /->>/g);
  const jsonArrowObjCount = countMatches(sql, /->[^>]/g);
  const totalJsonOps = jsonArrowCount + jsonArrowObjCount;

  if (totalJsonOps >= 20) {
    findings.push(
      finding(
        'heavy-json-extraction',
        'warning',
        `Heavy JSON extraction (${totalJsonOps} operations)`,
        `This query performs ${totalJsonOps} JSON extraction operations (->> and ->). Each extraction parses the JSON blob, and when applied repeatedly to the same column across many rows, this multiplies CPU and memory usage. JSON values are stored as strings, so they\'re also not columnar-efficient.`,
        'Consider: (1) Extract JSON fields into typed columns at ingest time (CREATE TABLE ... AS SELECT payload->>\'field\' AS field ...), (2) Use json_extract with multiple paths in a single call, or (3) Move JSON parsing into a dedicated CTE and reference the extracted columns downstream.',
        'performance',
        '->>',
      ),
    );
    const loc = locate(sql, '->>');
    if (loc) findings[findings.length - 1].offset = loc;
  } else if (totalJsonOps >= 8) {
    findings.push(
      finding(
        'moderate-json-extraction',
        'info',
        `Moderate JSON extraction (${totalJsonOps} operations)`,
        `This query performs ${totalJsonOps} JSON extraction operations. While manageable, each parses the JSON blob independently. On wide JSON payloads, this can add significant CPU overhead.`,
        'Consider extracting commonly-accessed JSON fields into typed columns at ingest time for better performance.',
        'performance',
        '->>',
      ),
    );
    const loc = locate(sql, '->>');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 6. json_each / json_extract_string with array paths — expands rows in memory
  if (/\bjson_each\s*\(/i.test(sql)) {
    findings.push(
      finding(
        'json-each-expansion',
        'warning',
        'json_each() row expansion',
        'json_each() explodes a JSON array or object into rows. If the JSON contains many elements, this can dramatically multiply the row count and memory usage, especially when combined with subsequent aggregation or sorting.',
        'Filter the JSON array before expanding if possible, or apply LIMIT/WHERE immediately after the json_each() to keep the expanded result set small.',
        'memory',
        'json_each(',
      ),
    );
    const loc = locate(sql, 'json_each(');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 7. json_extract_string with array wildcard paths
  if (/json_extract_string\s*\([^)]*\$\.\w+\[\*\]/i.test(sql)) {
    findings.push(
      finding(
        'json-array-extract',
        'info',
        'JSON array wildcard extraction',
        'json_extract_string() with a [*] wildcard path extracts all array elements. This creates a list in memory and, when combined with list_transform(), adds further memory pressure.',
        'If you only need a subset of array elements, filter before extraction. Consider flattening JSON arrays into separate rows at ingest time.',
        'memory',
      ),
    );
  }

  // =========================================================================
  // ORDER BY ... LIMIT 1 PATTERN (arg_max opportunity)
  // =========================================================================

  // 8. Repeated ORDER BY ... DESC LIMIT 1 — classic arg_max opportunity
  const orderByLimitMatches = findAll(sql, /ORDER\s+BY\s+\w+(?:\.\w+)?\s+DESC\s*\n\s*LIMIT\s+1/gi);
  if (orderByLimitMatches.length >= 2) {
    findings.push(
      finding(
        'repeated-order-limit-1',
        'warning',
        `ORDER BY ... DESC LIMIT 1 repeated ${orderByLimitMatches.length}x`,
        `This query uses the ORDER BY ... DESC LIMIT 1 pattern ${orderByLimitMatches.length} times to get the "latest" row. Each instance requires a full sort of the input. This is a common source of unnecessary memory usage and is especially costly in CTEs since DuckDB materializes each one.`,
        'Replace with arg_max(): SELECT arg_max(col, observed_at) FROM table. For multiple columns, use arg_max(struct_pack(col1, col2, ...), observed_at). This avoids the sort entirely.',
        'performance',
        orderByLimitMatches[0],
      ),
    );
    const loc = locate(sql, orderByLimitMatches[0]);
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 9. Window function ROW_NUMBER ... = 1 (arg_max opportunity)
  const windowForLatest = /ROW_NUMBER\s*\(\s*\)\s*OVER\s*\([^)]*ORDER\s+BY\b/gi;
  if (windowForLatest.test(sql) && /(?:row_number|rn|id_verification_response_row_number)\s*(?:=|<=)\s*[12]\b/i.test(sql)) {
    findings.push(
      finding(
        'use-arg-max',
        'info',
        'Consider arg_max() instead of ROW_NUMBER() window',
        'Using ROW_NUMBER() OVER (... ORDER BY ...) filtered to = 1 to get the "latest" or "best" row per group requires a full window sort — a blocking operator that buffers all rows. DuckDB\'s arg_max()/arg_min() achieves the same result more efficiently.',
        'Replace with: SELECT key, arg_max(value_col, order_col) FROM ... GROUP BY key. For multiple columns: arg_max(struct_pack(col1, col2), order_col).',
        'performance',
        'ROW_NUMBER()',
      ),
    );
    const loc = locate(sql, 'ROW_NUMBER()');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // =========================================================================
  // EXISTING RULES (with refinements)
  // =========================================================================

  // 10. LIKE '%...%' pattern
  const likePatterns = findAll(sql, /LIKE\s+'%[^']*%'/gi);
  for (const match of likePatterns) {
    findings.push(
      finding(
        'leading-wildcard-like',
        'warning',
        'LIKE with leading wildcard',
        "A LIKE pattern starting with '%' prevents DuckDB from using zone maps or min/max statistics for filtering, forcing a full column scan.",
        "If possible, use a trailing-only wildcard (LIKE 'prefix%'), use CONTAINS() or regexp_matches() for clarity, or consider a full-text search approach.",
        'performance',
        match,
      ),
    );
    const loc = locate(sql, match);
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 11. Function on column in WHERE (left side)
  const funcInWhere = findAll(
    sql,
    /WHERE\s+(?:.*?\s+AND\s+|.*?\s+OR\s+)*(?:UPPER|LOWER|TRIM|CAST|EXTRACT|DATE_TRUNC|YEAR|MONTH|DAY|STRFTIME|LENGTH|SUBSTRING|REPLACE)\s*\([^)]*\)\s*(?:=|!=|<|>|<=|>=|LIKE|IN)/gi,
  );
  if (funcInWhere.length > 0) {
    findings.push(
      finding(
        'function-on-filter-column',
        'warning',
        'Function applied to column in WHERE clause',
        'Wrapping a column in a function (e.g., UPPER(name) = ..., YEAR(created_at) = ...) prevents filter pushdown and forces DuckDB to evaluate every row.',
        'Store pre-computed values in the table or rewrite the condition to keep the column bare. For example, instead of YEAR(dt) = 2024, use dt >= \'2024-01-01\' AND dt < \'2025-01-01\'.',
        'performance',
      ),
    );
  }

  // 12. SELECT DISTINCT *
  if (/SELECT\s+DISTINCT\s+\*/i.test(sql)) {
    findings.push(
      finding(
        'distinct-star',
        'warning',
        'SELECT DISTINCT *',
        'DISTINCT * forces DuckDB to hash or sort ALL columns to find unique rows. This is extremely memory-intensive and rarely intentional.',
        'Select only the columns you need uniqueness on, or reconsider whether DISTINCT is necessary (maybe GROUP BY is more appropriate).',
        'memory',
        'SELECT DISTINCT *',
      ),
    );
    const loc = locate(sql, 'SELECT DISTINCT *');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 13. UNION without ALL
  const unionMatches = findAll(sql, /\bUNION\b(?!\s+ALL\b)/gi);
  if (unionMatches.length > 0) {
    findings.push(
      finding(
        'union-without-all',
        'info',
        'UNION without ALL',
        'UNION (without ALL) removes duplicate rows by hashing the entire result set. If duplicates are acceptable or impossible, this is wasted work.',
        'Use UNION ALL if you don\'t need deduplication. Also consider UNION BY NAME for tables with different column orders.',
        'performance',
        'UNION',
      ),
    );
    const loc = locate(sql, 'UNION');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 14. COUNT(DISTINCT ...) — memory warning
  const countDistinct = findAll(sql, /COUNT\s*\(\s*DISTINCT\b/gi);
  if (countDistinct.length > 0) {
    findings.push(
      finding(
        'count-distinct',
        'info',
        `COUNT(DISTINCT ...) detected (${countDistinct.length}x)`,
        `COUNT(DISTINCT) appears ${countDistinct.length} time(s). Each builds a hash set of all unique values in memory. On high-cardinality columns this is very memory-intensive.`,
        'If an approximate count is acceptable, consider using APPROX_COUNT_DISTINCT() which uses HyperLogLog and far less memory.',
        'memory',
        countDistinct[0],
      ),
    );
    const loc = locate(sql, countDistinct[0]);
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 15. NOT IN with subquery
  if (/NOT\s+IN\s*\(\s*SELECT/i.test(sql)) {
    findings.push(
      finding(
        'not-in-subquery',
        'warning',
        'NOT IN with subquery',
        'NOT IN with a subquery can be slow because it may prevent the optimizer from using an anti-join. It also has surprising NULL semantics — if the subquery returns any NULL, the entire NOT IN evaluates to NULL/false.',
        'Use NOT EXISTS (SELECT 1 FROM ... WHERE ...) instead, or a LEFT JOIN ... WHERE right.id IS NULL anti-join pattern.',
        'performance',
        'NOT IN (SELECT',
      ),
    );
    const loc = locate(sql, 'NOT IN');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 16. Correlated subquery in SELECT list
  if (/SELECT\s[\s\S]*?\(\s*SELECT\b[\s\S]*?WHERE[\s\S]*?\.\w+\s*=\s*\w+\.\w+/i.test(sql)) {
    findings.push(
      finding(
        'correlated-subquery',
        'error',
        'Possible correlated subquery',
        'A correlated subquery in the SELECT list or WHERE clause re-executes for every row of the outer query. This is extremely slow on large tables.',
        'Rewrite as a JOIN or use a CTE. For example: WITH sub AS (SELECT ...) SELECT ... FROM main JOIN sub ON ...',
        'performance',
        'correlated subquery',
      ),
    );
  }

  // 17. INSERT INTO ... SELECT *
  if (/INSERT\s+INTO\b[\s\S]*?SELECT\s+\*/i.test(sql)) {
    findings.push(
      finding(
        'insert-select-star',
        'info',
        'INSERT INTO ... SELECT *',
        'Large INSERT ... SELECT operations preserve insertion order by default, which requires buffering the entire result. This can cause OOM on large datasets.',
        'Run SET preserve_insertion_order = false; before the insert if row order doesn\'t matter. This significantly reduces memory usage.',
        'memory',
        'INSERT INTO ... SELECT *',
      ),
    );
  }

  // 18. Many CTEs
  const cteCount = (upper.match(/\bAS\s*\(/g) || []).length;
  if (cteCount > 10) {
    findings.push(
      finding(
        'many-ctes',
        'warning',
        `${cteCount} CTEs detected`,
        `This query has ${cteCount} CTEs. DuckDB materializes each CTE, meaning all intermediate results are held in memory simultaneously. With ${cteCount} CTEs — each potentially containing blocking operators like ORDER BY or GROUP BY — the combined memory footprint can be substantial.`,
        'Consider breaking this into multiple sequential queries with CREATE TEMP TABLE to materialize intermediate results, allowing DuckDB to release memory between stages. Focus on CTEs that produce large intermediate results.',
        'memory',
      ),
    );
  } else if (cteCount > 5) {
    findings.push(
      finding(
        'many-ctes',
        'info',
        `${cteCount} CTEs detected`,
        `This query has ${cteCount} CTEs. DuckDB materializes each CTE. While CTEs improve readability, excessive CTEs may increase peak memory usage.`,
        'Consider whether some CTEs can be inlined or merged. DuckDB auto-materializes duplicate CTEs, so focus on eliminating unused ones.',
        'memory',
      ),
    );
  }

  // 19. Window functions without QUALIFY
  const hasWindowFunc = /\b(ROW_NUMBER|RANK|DENSE_RANK|NTILE|LAG|LEAD|FIRST_VALUE|LAST_VALUE)\s*\(/i.test(sql);
  const hasQualify = /\bQUALIFY\b/i.test(sql);
  const hasWhereOnWindow = hasWindowFunc && !hasQualify && /WHERE\b[\s\S]*?\b(ROW_NUMBER|RANK|DENSE_RANK)\b/i.test(sql);

  if (hasWhereOnWindow) {
    findings.push(
      finding(
        'window-without-qualify',
        'info',
        'Window function filtered in WHERE instead of QUALIFY',
        'DuckDB supports QUALIFY, which filters on window function results directly — no subquery needed. Using WHERE on a window function result requires wrapping in a subquery.',
        'Use QUALIFY instead: SELECT ... FROM ... QUALIFY ROW_NUMBER() OVER (...) <= N',
        'best-practice',
      ),
    );
  }

  // 20. Excessive CAST operations
  const castOps = findAll(sql, /(?:CAST\s*\([^)]+AS\s+(?:BOOLEAN|INTEGER|DOUBLE|BIGINT|DATE|TIMESTAMP)\s*\)|::\s*(?:BOOLEAN|INTEGER|DOUBLE|BIGINT|TIMESTAMPTZ?)\b)/gi);
  if (castOps.length > 8) {
    findings.push(
      finding(
        'excessive-casts',
        'info',
        `${castOps.length} type cast operations`,
        `This query has ${castOps.length} explicit type casts. This often means data is stored as JSON or VARCHAR and cast at query time. Each cast adds CPU overhead and prevents DuckDB from using native type optimizations.`,
        'Store data in native types (BOOLEAN, INTEGER, TIMESTAMP, etc.) at ingest time. For JSON payloads, consider extracting frequently-queried fields into typed columns.',
        'schema',
      ),
    );
  }

  // 21. MotherDuck-specific: Large data transfer between local and remote
  if (/FROM\s+read_(?:csv|parquet|json)\s*\(/i.test(sql) && /\bmd:/i.test(sql)) {
    findings.push(
      finding(
        'md-local-remote-transfer',
        'warning',
        'Possible large local-to-cloud data transfer',
        'Reading local files (read_csv, read_parquet) and joining with MotherDuck cloud tables causes data to be uploaded via Bridge. Large local files will bottleneck on network upload speed.',
        'Consider uploading the local data to MotherDuck first (CREATE TABLE ... AS SELECT * FROM read_csv(...)), then join cloud-to-cloud for better performance.',
        'network',
      ),
    );
  }

  // 22. GROUP BY ALL reminder
  const groupByPattern = /GROUP\s+BY\s+(?!ALL\b)\w+(?:\s*,\s*\w+){3,}/gi;
  if (groupByPattern.test(sql)) {
    findings.push(
      finding(
        'group-by-verbose',
        'info',
        'Verbose GROUP BY',
        'DuckDB supports GROUP BY ALL which automatically groups by all non-aggregated columns. This reduces errors when modifying the SELECT list.',
        'Replace the explicit column list with GROUP BY ALL for convenience.',
        'best-practice',
      ),
    );
  }

  // 23. Reading remote files without column selection
  if (/FROM\s+(?:read_parquet|read_csv|read_json)\s*\(\s*'https?:/i.test(sql) && /SELECT\s+\*/i.test(sql)) {
    findings.push(
      finding(
        'remote-file-select-star',
        'error',
        'SELECT * from remote file',
        'Reading all columns from a remote Parquet/CSV file downloads the entire file over the network. This is extremely slow for wide tables.',
        'Select only the columns you need. For remote Parquet, DuckDB can do column pruning and predicate pushdown — but only if you specify columns and WHERE filters.',
        'network',
      ),
    );
  }

  // 24. MotherDuck duckling size hint
  if (upper.includes('OUT OF MEMORY') || upper.includes('OOM')) {
    findings.push(
      finding(
        'md-duckling-size',
        'info',
        'Consider a larger Duckling size',
        'If this query runs out of memory on MotherDuck, consider upgrading from Pulse to Standard, Jumbo, Mega, or Giga Ducklings for more memory.',
        'Change your Duckling size in MotherDuck settings. Also try SET preserve_insertion_order = false; and SET temp_directory to enable spilling.',
        'memory',
      ),
    );
  }

  // =========================================================================
  // NEW: list_transform / flatten — additional memory operations
  // =========================================================================

  // 25. list_transform — in-memory list processing
  if (/\blist_transform\s*\(/i.test(sql)) {
    findings.push(
      finding(
        'list-transform',
        'info',
        'list_transform() — in-memory list processing',
        'list_transform() applies a lambda to every element of a list in memory. When combined with other list operations (list_concat, flatten, array_to_string), the entire chain is non-spillable.',
        'Consider whether this transformation can be done at ingest time or via a simpler SQL expression. For string building, a CTE with UNNEST + string_agg may give the optimizer more room.',
        'memory',
        'list_transform(',
      ),
    );
    const loc = locate(sql, 'list_transform(');
    if (loc) findings[findings.length - 1].offset = loc;
  }

  // 26. PIVOT — internally uses list() which cannot spill to disk
  if (/\bPIVOT\b/i.test(sql) && !/\bUNPIVOT\b/i.test(sql) || /\bPIVOT\b[\s\S]*?\bUSING\b/i.test(sql)) {
    findings.push(
      finding(
        'non-spillable-pivot',
        'error',
        'PIVOT uses list() internally — cannot spill to disk',
        'DuckDB\'s PIVOT statement internally uses the list() aggregate to collect values before spreading them into columns. Since list() cannot spill to disk, PIVOT on large datasets or high-cardinality pivot columns will cause out-of-memory crashes. This is documented in the DuckDB "Tuning Workloads" guide as a non-spillable operator.',
        'Consider: (1) pre-filter or pre-aggregate data before pivoting to reduce input size, (2) limit the number of distinct pivot values with a WHERE or IN clause on the pivot column, (3) break the pivot into smaller batches by partitioning the data, or (4) use a manual CASE WHEN approach: SUM(CASE WHEN flag = \'X\' THEN 1 ELSE 0 END) AS x — which uses only spillable operators.',
        'memory',
        'pivot',
      ),
    );
  }

  // 27. LEFT JOIN ... ON TRUE (many of them = all CTEs cross-joined)
  const leftJoinOnTrue = countMatches(sql, /LEFT\s+JOIN\s+\w+\s+ON\s+TRUE/gi);
  if (leftJoinOnTrue >= 5) {
    findings.push(
      finding(
        'many-left-join-on-true',
        'info',
        `${leftJoinOnTrue} LEFT JOIN ... ON TRUE`,
        `This query uses LEFT JOIN ... ON TRUE ${leftJoinOnTrue} times to combine CTE results. This is a valid pattern when each CTE returns a single row, but if any CTE unexpectedly returns multiple rows, the result will silently multiply.`,
        'Consider adding an assertion or defensive LIMIT 1 to CTEs that are expected to return a single row. Alternatively, use scalar subqueries in the final SELECT.',
        'best-practice',
      ),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runRules(ast: AST | AST[], sql: string): Finding[] {
  const asts = Array.isArray(ast) ? ast : [ast];
  const findings: Finding[] = [];

  for (const node of asts) {
    if (!node) continue;
    findings.push(...checkSelectStar(node, sql));
    findings.push(...checkOrderByWithoutLimit(node, sql));
    findings.push(...checkCrossJoin(node, sql));
    findings.push(...checkNestedSubqueries(node, sql));
    findings.push(...checkJoinWithoutCondition(node, sql));
  }

  findings.push(...regexRules(sql));

  // Deduplicate by ruleId
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.ruleId)) return false;
    seen.add(f.ruleId);
    return true;
  });
}
