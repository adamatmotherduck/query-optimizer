import type { Finding } from '../analyzer/types';

interface FindingsPanelProps {
  findings: Finding[];
  onFindingClick?: (ruleId: string) => void;
}

const severityIcons: Record<string, string> = {
  error: '\u2718',   // ✘
  warning: '\u26A0', // ⚠
  info: '\u2139',    // ℹ
};

const severityLabels: Record<string, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};

const categoryLabels: Record<string, string> = {
  performance: 'Performance',
  memory: 'Memory',
  network: 'Network',
  schema: 'Schema',
  'best-practice': 'Best Practice',
};

export default function FindingsPanel({ findings, onFindingClick }: FindingsPanelProps) {
  if (findings.length === 0) return null;

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const infos = findings.filter((f) => f.severity === 'info');

  return (
    <div className="findings-panel">
      <div className="findings-header">
        <h3>
          Analysis Results
          <span className="findings-count">
            {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
          </span>
        </h3>
        <div className="findings-summary">
          {errors.length > 0 && (
            <span className="badge badge-error">{errors.length} error{errors.length > 1 ? 's' : ''}</span>
          )}
          {warnings.length > 0 && (
            <span className="badge badge-warning">{warnings.length} warning{warnings.length > 1 ? 's' : ''}</span>
          )}
          {infos.length > 0 && (
            <span className="badge badge-info">{infos.length} suggestion{infos.length > 1 ? 's' : ''}</span>
          )}
        </div>
      </div>

      <div className="findings-list">
        {findings.map((f, i) => {
          const hasLocation = !!(f.offset || f.fragment);
          const clickable = hasLocation && !!onFindingClick;
          return (
            <div
              key={i}
              className={`finding-card finding-${f.severity}${clickable ? ' finding-clickable' : ''}`}
              onClick={clickable ? () => onFindingClick(f.ruleId) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onFindingClick(f.ruleId); } : undefined}
            >
              <div className="finding-card-header">
                <span className={`finding-icon finding-icon-${f.severity}`}>
                  {severityIcons[f.severity]}
                </span>
                <span className="finding-title">{f.title}</span>
                {clickable && <span className="finding-jump-hint">{'\u2191'} Jump to code</span>}
                <span className={`finding-severity-badge severity-${f.severity}`}>
                  {severityLabels[f.severity]}
                </span>
                <span className="finding-category">{categoryLabels[f.category]}</span>
              </div>
              <p className="finding-message">{f.message}</p>
              <div className="finding-suggestion">
                <strong>Recommendation:</strong> {f.suggestion}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
