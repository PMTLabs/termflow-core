import { COLOR_SCHEMAS, DEFAULT_COLOR_SCHEMA_ID, getColorSchema, getSchemaTheme } from '../colorSchemas';

const REQUIRED_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

describe('colorSchemas', () => {
  it('every preset provides all required xterm ITheme keys as hex colors', () => {
    for (const schema of COLOR_SCHEMAS) {
      for (const key of REQUIRED_KEYS) {
        expect(schema.theme[key]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('preset ids are unique', () => {
    const ids = COLOR_SCHEMAS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getColorSchema falls back to default for an unknown id', () => {
    expect(getColorSchema('does-not-exist').id).toBe(DEFAULT_COLOR_SCHEMA_ID);
  });

  it('getSchemaTheme returns the matching preset theme', () => {
    expect(getSchemaTheme('dracula')).toBe(getColorSchema('dracula').theme);
  });
});
