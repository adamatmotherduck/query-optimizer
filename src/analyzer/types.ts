export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  suggestion: string;
  /** Character offset range in the original SQL string */
  offset?: { start: number; end: number };
  /** The problematic SQL fragment */
  fragment?: string;
  category: 'performance' | 'memory' | 'network' | 'schema' | 'best-practice';
}

export interface AnalysisResult {
  findings: Finding[];
  parseError: string | null;
}
