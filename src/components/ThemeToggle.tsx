import type { ThemeMode } from '../theme';

interface ThemeToggleProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

const options: { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '\u2600' },     // ☀
  { value: 'system', label: 'System', icon: '\u2699' },    // ⚙
  { value: 'dark', label: 'Dark', icon: '\u263E' },        // ☾
];

export default function ThemeToggle({ mode, onChange }: ThemeToggleProps) {
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Color theme">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`theme-toggle-btn ${mode === opt.value ? 'active' : ''}`}
          onClick={() => onChange(opt.value)}
          aria-checked={mode === opt.value}
          role="radio"
          title={opt.label}
        >
          <span className="theme-toggle-icon">{opt.icon}</span>
        </button>
      ))}
    </div>
  );
}
