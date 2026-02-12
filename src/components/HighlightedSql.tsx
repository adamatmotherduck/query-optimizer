import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { Finding } from '../analyzer/types';

interface HighlightedSqlProps {
  sql: string;
  findings: Finding[];
  /** When set externally (e.g. from FindingsPanel click), this ruleId will be scrolled-to and pulsed */
  focusedRuleId?: string | null;
  onFocusHandled?: () => void;
}

interface Segment {
  text: string;
  finding?: Finding;
}

function buildSegments(sql: string, findings: Finding[]): Segment[] {
  // Build a list of annotated ranges from findings that have fragments
  const ranges: { start: number; end: number; finding: Finding }[] = [];
  const lowerSql = sql.toLowerCase();

  for (const f of findings) {
    if (f.fragment) {
      // Find ALL occurrences of the fragment (case-insensitive)
      const lowerFrag = f.fragment.toLowerCase();
      let searchFrom = 0;
      while (searchFrom < lowerSql.length) {
        const idx = lowerSql.indexOf(lowerFrag, searchFrom);
        if (idx === -1) break;
        ranges.push({ start: idx, end: idx + f.fragment.length, finding: f });
        searchFrom = idx + f.fragment.length;
      }
    } else if (f.offset) {
      ranges.push({ start: f.offset.start, end: f.offset.end, finding: f });
    }
  }

  // Sort by start position
  ranges.sort((a, b) => a.start - b.start);

  // Remove overlaps (keep earlier ones)
  const cleaned: typeof ranges = [];
  let lastEnd = 0;
  for (const r of ranges) {
    if (r.start >= lastEnd) {
      cleaned.push(r);
      lastEnd = r.end;
    }
  }

  // Build segments
  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of cleaned) {
    if (r.start > cursor) {
      segments.push({ text: sql.slice(cursor, r.start) });
    }
    segments.push({ text: sql.slice(r.start, r.end), finding: r.finding });
    cursor = r.end;
  }
  if (cursor < sql.length) {
    segments.push({ text: sql.slice(cursor) });
  }

  return segments;
}

const severityColors: Record<string, string> = {
  error: '#ff4d6a',
  warning: '#ffa726',
  info: '#42a5f5',
};

export default function HighlightedSql({ sql, findings, focusedRuleId, onFocusHandled }: HighlightedSqlProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const segments = useMemo(() => buildSegments(sql, findings), [sql, findings]);
  const issueRefs = useRef<Map<string, HTMLSpanElement>>(new Map());

  const showTooltip = useCallback((idx: number, el: HTMLSpanElement) => {
    setActiveIdx(idx);
    const rect = el.getBoundingClientRect();
    setTooltipPos({ top: rect.bottom + 8, left: rect.left });
  }, []);

  const hideTooltip = useCallback(() => {
    setActiveIdx(null);
    setTooltipPos(null);
  }, []);

  const handleClick = useCallback((idx: number, el: HTMLSpanElement) => {
    if (activeIdx === idx) {
      hideTooltip();
    } else {
      showTooltip(idx, el);
    }
  }, [activeIdx, hideTooltip, showTooltip]);

  // When focusedRuleId changes from the FindingsPanel, scroll to and pulse that span
  useEffect(() => {
    if (!focusedRuleId) return;
    const el = issueRefs.current.get(focusedRuleId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pulse');
      // Also activate the tooltip
      const idx = segments.findIndex((s) => s.finding?.ruleId === focusedRuleId);
      if (idx !== -1) showTooltip(idx, el);
      const timer = setTimeout(() => {
        el.classList.remove('pulse');
        onFocusHandled?.();
      }, 1200);
      return () => clearTimeout(timer);
    }
    onFocusHandled?.();
  }, [focusedRuleId, onFocusHandled, segments, showTooltip]);

  if (!sql) return null;

  const activeFinding = activeIdx !== null ? segments[activeIdx]?.finding : null;
  const activeColor = activeFinding ? (severityColors[activeFinding.severity] || '#42a5f5') : '#42a5f5';

  return (
    <div className="highlighted-sql-container">
      <pre className="highlighted-sql">
        <code>
          {segments.map((seg, i) => {
            if (!seg.finding) {
              return <span key={i}>{seg.text}</span>;
            }
            const color = severityColors[seg.finding.severity] || '#42a5f5';
            const isActive = activeIdx === i;
            const ruleId = seg.finding.ruleId;
            return (
              <span
                key={i}
                ref={(el) => {
                  if (el) issueRefs.current.set(ruleId, el);
                }}
                data-rule-id={ruleId}
                className={`sql-issue ${isActive ? 'active' : ''}`}
                style={{
                  backgroundColor: `${color}22`,
                  borderBottom: `2px solid ${color}`,
                  cursor: 'pointer',
                  position: 'relative',
                }}
                onClick={(e) => handleClick(i, e.currentTarget)}
                onMouseEnter={(e) => showTooltip(i, e.currentTarget)}
                onMouseLeave={hideTooltip}
              >
                {seg.text}
              </span>
            );
          })}
        </code>
      </pre>
      {activeFinding && tooltipPos && (
        <span
          className="sql-tooltip"
          style={{
            borderLeftColor: activeColor,
            position: 'fixed',
            top: tooltipPos.top,
            left: tooltipPos.left,
          }}
          onMouseEnter={() => setActiveIdx(activeIdx)}
          onMouseLeave={hideTooltip}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="tooltip-title" style={{ color: activeColor }}>
            {activeFinding.title}
          </span>
          <span className="tooltip-message">{activeFinding.message}</span>
          <span className="tooltip-suggestion">
            <strong>Fix:</strong> {activeFinding.suggestion}
          </span>
        </span>
      )}
    </div>
  );
}
