import React from 'react';
import { COLOR_SCHEMAS, getSchemaTheme } from '../../store/colorSchemas';

// The 16 ANSI keys rendered as swatch dots, in the canonical order shared by
// SettingsPage's schema grid and every context menu that reuses it.
const SWATCH_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

interface ColorSchemaGridProps {
  /** Currently-selected schema id; undefined highlights the "default" card. */
  activeId?: string;
  /** Called with a schema id, or undefined for the "use default" card. */
  onPick: (id?: string) => void;
  /** Schema whose swatches preview on the "default" card. */
  defaultSwatchSchemaId: string;
  /** Label for the "default" card (e.g. "Use Settings Default" / "Use tab / default"). */
  defaultLabel?: string;
}

/**
 * The swatch-card schema picker shared by the Tab, Pane, and (via a secondary
 * menu) terminal context menus. Base `.color-schema-*` styles come from
 * SettingsPage.css (global); each host adds its own scoped scroll overrides.
 */
export const ColorSchemaGrid: React.FC<ColorSchemaGridProps> = ({
  activeId,
  onPick,
  defaultSwatchSchemaId,
  defaultLabel = 'Use Settings Default',
}) => (
  <div className="color-schema-grid">
    <button
      type="button"
      className={`color-schema-card${!activeId ? ' active' : ''}`}
      onClick={() => onPick(undefined)}
    >
      <div className="color-schema-swatches">
        {SWATCH_KEYS.map((key) => (
          <span key={key} className="color-schema-dot" style={{ background: getSchemaTheme(defaultSwatchSchemaId)[key] }} />
        ))}
      </div>
      <span className="color-schema-name">{defaultLabel}</span>
    </button>
    {COLOR_SCHEMAS.map((schema) => (
      <button
        key={schema.id}
        type="button"
        className={`color-schema-card${activeId === schema.id ? ' active' : ''}`}
        onClick={() => onPick(schema.id)}
      >
        <div className="color-schema-swatches">
          {SWATCH_KEYS.map((key) => (
            <span key={key} className="color-schema-dot" style={{ background: schema.theme[key] }} />
          ))}
        </div>
        <span className="color-schema-name">{schema.name}</span>
      </button>
    ))}
  </div>
);
