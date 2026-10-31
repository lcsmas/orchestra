import { createPortal } from 'react-dom';
import { DEFAULT_DENSITY, DENSITY_LIMITS, setSidebarDensity, useSidebarDensity, type SidebarDensity } from '../sidebar-density';

/** "Aa" window: sidebar text size / row height / gap, live and persisted (sidebar-density.ts). */
export function SidebarAppearanceSettings({ onClose }: { onClose: () => void }) {
  const d = useSidebarDensity();
  const row = (k: keyof SidebarDensity, label: string) => {
    const { min, max, step } = DENSITY_LIMITS[k];
    return (
      <label className="density-row" key={k}>
        <span>{label}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={d[k]}
          aria-label={label}
          data-density={k}
          onChange={(e) => setSidebarDensity({ ...d, [k]: Number(e.target.value) })}
        />
        <span className="density-value">{d[k]}px</span>
      </label>
    );
  };
  // Portal to <body>, like the other settings dialogs — but with a CLEAR backdrop and docked beside the sidebar:
  // the standard blurred backdrop hid the very rows the sliders change (seen in the drive capture).
  const left = (document.querySelector('aside.sidebar')?.getBoundingClientRect().right ?? 340) + 16;
  return createPortal(
    <div className="modal-backdrop density-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal density-settings" role="dialog" aria-label="Sidebar appearance" style={{ left }}>
        <h2>Sidebar appearance</h2>
        {row('font', 'Text size')}
        {row('rowH', 'Row height')}
        {row('gap', 'Gap between rows')}
        <div className="modal-actions">
          <button className="secondary" onClick={() => setSidebarDensity(DEFAULT_DENSITY)}>Reset</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
