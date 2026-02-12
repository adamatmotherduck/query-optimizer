// Import only the PostgreSQL grammar to shrink the bundle (~300KB vs ~2.8MB)
import { Parser } from 'node-sql-parser/build/postgresql';
import { runRules } from './rules';
import type { AnalysisResult } from './types';

const parser = new Parser();

/**
 * Replace a function call (with balanced parentheses) with a substitute string.
 * Handles nested parens correctly, e.g. list_transform(json_extract_string(x), t -> UPPER(t))
 */
function replaceBalancedCall(s: string, funcName: string, replacement: string): string {
  const re = new RegExp(`\\b${funcName}\\s*\\(`, 'gi');
  let match;
  while ((match = re.exec(s)) !== null) {
    const start = match.index;
    const parenStart = start + match[0].length - 1;
    let depth = 1;
    let i = parenStart + 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      i++;
    }
    if (depth === 0) {
      s = s.slice(0, start) + replacement + s.slice(i);
      re.lastIndex = start + replacement.length;
    }
  }
  return s;
}

/**
 * Preprocess SQL to remove DuckDB-specific syntax that the PostgreSQL
 * grammar in node-sql-parser cannot handle, so we get an AST more often.
 * The original SQL is still passed to the regex-based rules untouched.
 */
function preprocessForParser(sql: string): string {
  let s = sql;

  // Remove ::TYPE casts  e.g. (payload->'score')::INTEGER, val::BOOLEAN
  // Handles optional array suffix like ::INTEGER[]
  s = s.replace(/::[A-Za-z_][A-Za-z0-9_]*(\[\])?/g, '');

  // Replace DuckDB-only functions with balanced-paren matching
  s = replaceBalancedCall(s, 'list_transform', 'NULL');
  s = replaceBalancedCall(s, 'json_extract_string', 'NULL');
  s = replaceBalancedCall(s, 'json_each', '(SELECT 1)');
  s = replaceBalancedCall(s, 'LIST', 'ARRAY_AGG(1)');
  s = replaceBalancedCall(s, 'struct_pack', 'ROW(1)');

  // Replace PIVOT ... ON ... USING agg(...) with SELECT * FROM table
  s = s.replace(
    /\bPIVOT\s+((?:"\w+"\.)*"?\w+"?)\s+ON\s+[\s\S]*?\bUSING\s+\w+\s*\([^)]*\)(?:\s*,\s*\w+\s*\([^)]*\))*/gi,
    'SELECT * FROM $1',
  );

  // Replace UNPIVOT ... ON ... IN (...) with SELECT * FROM table
  s = s.replace(
    /\bUNPIVOT\s+((?:"\w+"\.)*"?\w+"?)\s+ON\s+[\s\S]*?\bIN\s*\([^)]*\)/gi,
    'SELECT * FROM $1',
  );

  return s;
}

export function analyze(sql: string): AnalysisResult {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { findings: [], parseError: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ast: any = null;
  let parseError: string | null = null;

  // Try parsing the preprocessed SQL to get an AST
  const sanitized = preprocessForParser(trimmed);
  try {
    ast = parser.astify(sanitized);
  } catch (e) {
    parseError = e instanceof Error ? e.message : 'Failed to parse SQL';
  }

  // Regex-based rules always run against the ORIGINAL SQL
  const findings = runRules(ast, trimmed);

  return { findings, parseError };
}

export type { Finding, AnalysisResult, Severity } from './types';
