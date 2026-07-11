import { DEFAULT_THEME } from '@termflow/terminal-core';

export interface ColorSchema {
  id: string;
  name: string;
  theme: Record<string, string>; // xterm ITheme-shaped (background/foreground/cursor/16 ANSI keys)
}

export const COLOR_SCHEMAS: ColorSchema[] = [
  // Single source of truth for the existing look — same object the terminal
  // already renders today.
  { id: 'default', name: 'Default', theme: DEFAULT_THEME },
  {
    // Windows Terminal's own default scheme ("Campbell").
    id: 'campbell', name: 'Windows Terminal', theme: {
      background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', cursorAccent: '#000000',
      black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00',
      blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
      brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5',
      brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
    },
  },
  {
    // Dracula's official published palette (draculatheme.com).
    id: 'dracula', name: 'Dracula', theme: {
      background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', cursorAccent: '#282A36',
      black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C',
      blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
      brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5',
      brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
    },
  },
  {
    // Nord's official published palette (nordtheme.com).
    id: 'nord', name: 'Nord', theme: {
      background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9', cursorAccent: '#2E3440',
      black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B',
      blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
      brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B',
      brightBlue: '#81A1C1', brightMagenta: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
    },
  },
  {
    // Solarized's official 16-color terminal mapping (ethanschoonover.com/solarized).
    id: 'solarized-dark', name: 'Solarized Dark', theme: {
      background: '#002B36', foreground: '#839496', cursor: '#93A1A1', cursorAccent: '#002B36',
      black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
      blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
      brightBlack: '#002B36', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83',
      brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
    },
  },
  {
    // Atom's "One Dark" terminal palette.
    id: 'one-dark', name: 'One Dark', theme: {
      background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', cursorAccent: '#282C34',
      black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B',
      blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#ABB2BF',
      brightBlack: '#5C6370', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B',
      brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#FFFFFF',
    },
  },
  {
    // Gruvbox's official published palette (morhetz/gruvbox).
    id: 'gruvbox-dark', name: 'Gruvbox Dark', theme: {
      background: '#282828', foreground: '#EBDBB2', cursor: '#EBDBB2', cursorAccent: '#282828',
      black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921',
      blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
      brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26', brightYellow: '#FABD2F',
      brightBlue: '#83A598', brightMagenta: '#D3869B', brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
    },
  },
  {
    // The classic Monokai terminal palette.
    id: 'monokai', name: 'Monokai', theme: {
      background: '#272822', foreground: '#F8F8F2', cursor: '#F8F8F0', cursorAccent: '#272822',
      black: '#272822', red: '#F92672', green: '#A6E22E', yellow: '#F4BF75',
      blue: '#66D9EF', magenta: '#AE81FF', cyan: '#A1EFE4', white: '#F8F8F2',
      brightBlack: '#75715E', brightRed: '#F92672', brightGreen: '#A6E22E', brightYellow: '#F4BF75',
      brightBlue: '#66D9EF', brightMagenta: '#AE81FF', brightCyan: '#A1EFE4', brightWhite: '#F9F8F5',
    },
  },
  {
    // GNOME Terminal / VTE default (Tango-derived) — the palette commonly
    // associated with Ubuntu and, by extension, WSL.
    id: 'ubuntu', name: 'Ubuntu (WSL)', theme: {
      background: '#300A24', foreground: '#FFFFFF', cursor: '#FFFFFF', cursorAccent: '#300A24',
      black: '#2E3436', red: '#CC0000', green: '#4E9A06', yellow: '#C4A000',
      blue: '#3465A4', magenta: '#75507B', cyan: '#06989A', white: '#D3D7CF',
      brightBlack: '#555753', brightRed: '#EF2929', brightGreen: '#8AE234', brightYellow: '#FCE94F',
      brightBlue: '#729FCF', brightMagenta: '#AD7FA8', brightCyan: '#34E2E2', brightWhite: '#EEEEEC',
    },
  },
  {
    // Classic Borland Turbo Pascal IDE — blue background, standard 16-color
    // CGA/ANSI.SYS palette, light-gray foreground (the IDE's default body-text
    // color; yellow was reserved for keywords).
    id: 'turbo-pascal', name: 'Turbo Pascal', theme: {
      background: '#0000AA', foreground: '#AAAAAA', cursor: '#FFFFFF', cursorAccent: '#0000AA',
      black: '#000000', red: '#AA0000', green: '#00AA00', yellow: '#AA5500',
      blue: '#0000AA', magenta: '#AA00AA', cyan: '#00AAAA', white: '#AAAAAA',
      brightBlack: '#555555', brightRed: '#FF5555', brightGreen: '#55FF55', brightYellow: '#FFFF55',
      brightBlue: '#5555FF', brightMagenta: '#FF55FF', brightCyan: '#55FFFF', brightWhite: '#FFFFFF',
    },
  },
  {
    // Solarized's official light variant — same 16 accent values as the
    // shipped Solarized Dark above (ethanschoonover.com/solarized).
    id: 'solarized-light', name: 'Solarized Light', theme: {
      background: '#FDF6E3', foreground: '#657B83', cursor: '#586E75', cursorAccent: '#FDF6E3',
      black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900',
      blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
      brightBlack: '#002B36', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83',
      brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
      // xterm's default selection color is a semi-transparent white, which is
      // nearly invisible on this scheme's already-light cream background.
      selectionBackground: 'rgba(38, 139, 210, 0.35)',
    },
  },
  {
    // "Tomorrow" (Chris Kempson) — a canonical palette designed for light
    // backgrounds, chosen over a GitHub-style palette because GitHub's
    // standard yellow is near-invisible on a white background.
    id: 'tomorrow', name: 'Tomorrow (Light)', theme: {
      background: '#FFFFFF', foreground: '#4D4D4C', cursor: '#4D4D4C', cursorAccent: '#FFFFFF',
      black: '#000000', red: '#C82829', green: '#718C00', yellow: '#EAB700',
      blue: '#4271AE', magenta: '#8959A8', cyan: '#3E999F', white: '#FFFFFF',
      brightBlack: '#8E908C', brightRed: '#C82829', brightGreen: '#718C00', brightYellow: '#EAB700',
      brightBlue: '#4271AE', brightMagenta: '#8959A8', brightCyan: '#3E999F', brightWhite: '#FFFFFF',
      // xterm's default selection color is a semi-transparent white, which is
      // nearly invisible on this scheme's white background.
      selectionBackground: 'rgba(66, 113, 174, 0.35)',
    },
  },
  {
    // Original "Sunset" palette designed for this app — a dusky, mid-toned
    // warm scheme deliberately sitting between the dark and light presets
    // above (not a pure-black or pure-white background).
    id: 'sunset', name: 'Sunset', theme: {
      background: '#3B2C35', foreground: '#F4E3C9', cursor: '#FFB37A', cursorAccent: '#3B2C35',
      black: '#2B1F28', red: '#E8533D', green: '#8FB573', yellow: '#F2C14E',
      blue: '#5C6FA8', magenta: '#C25B8B', cyan: '#6FA8A0', white: '#D9C7B8',
      brightBlack: '#5A4A52', brightRed: '#FF7A5C', brightGreen: '#B5D99C', brightYellow: '#FFDD7E',
      brightBlue: '#7E94D1', brightMagenta: '#E07FB0', brightCyan: '#93D1C8', brightWhite: '#FAF0E1',
    },
  },
  {
    // Tokyo Night (enkia) — palette via Tabby's community-color-schemes collection.
    id: 'tokyo-night', name: 'Tokyo Night', theme: {
      background: '#1A1B26', foreground: '#C0CAF5', cursor: '#C0CAF5', cursorAccent: '#1A1B26',
      black: '#15161E', red: '#F7768E', green: '#9ECE6A', yellow: '#E0AF68',
      blue: '#7AA2F7', magenta: '#BB9AF7', cyan: '#7DCFFF', white: '#A9B1D6',
      brightBlack: '#414868', brightRed: '#F7768E', brightGreen: '#9ECE6A', brightYellow: '#E0AF68',
      brightBlue: '#7AA2F7', brightMagenta: '#BB9AF7', brightCyan: '#7DCFFF', brightWhite: '#C0CAF5',
    },
  },
  {
    // Tokyo Night Day — the official light variant of Tokyo Night, via Tabby's
    // community-color-schemes collection.
    id: 'tokyo-night-day', name: 'Tokyo Night Day', theme: {
      background: '#E1E2E7', foreground: '#3760BF', cursor: '#3760BF', cursorAccent: '#E1E2E7',
      black: '#E9E9ED', red: '#F52A65', green: '#587539', yellow: '#8C6C3E',
      blue: '#2E7DE9', magenta: '#9854F1', cyan: '#007197', white: '#6172B0',
      brightBlack: '#A1A6C5', brightRed: '#F52A65', brightGreen: '#587539', brightYellow: '#8C6C3E',
      brightBlue: '#2E7DE9', brightMagenta: '#9854F1', brightCyan: '#007197', brightWhite: '#3760BF',
      // xterm's default selection color is a semi-transparent white, which is
      // nearly invisible on this scheme's light background.
      selectionBackground: 'rgba(46, 125, 233, 0.35)',
    },
  },
  {
    // Rosé Pine (rosepinetheme.com) — via Tabby's community-color-schemes collection.
    id: 'rose-pine', name: 'Rosé Pine', theme: {
      background: '#191724', foreground: '#E0DEF4', cursor: '#555169', cursorAccent: '#191724',
      black: '#26233A', red: '#EB6F92', green: '#31748F', yellow: '#F6C177',
      blue: '#9CCFD8', magenta: '#C4A7E7', cyan: '#EBBCBA', white: '#E0DEF4',
      brightBlack: '#6E6A86', brightRed: '#EB6F92', brightGreen: '#31748F', brightYellow: '#F6C177',
      brightBlue: '#9CCFD8', brightMagenta: '#C4A7E7', brightCyan: '#EBBCBA', brightWhite: '#E0DEF4',
    },
  },
  {
    // Rosé Pine Dawn — the official light variant of Rosé Pine (rosepinetheme.com),
    // via Tabby's community-color-schemes collection.
    id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', theme: {
      background: '#FAF4ED', foreground: '#575279', cursor: '#9893A5', cursorAccent: '#FAF4ED',
      black: '#F2E9DE', red: '#B4637A', green: '#286983', yellow: '#EA9D34',
      blue: '#56949F', magenta: '#907AA9', cyan: '#D7827E', white: '#575279',
      brightBlack: '#6E6A86', brightRed: '#B4637A', brightGreen: '#286983', brightYellow: '#EA9D34',
      brightBlue: '#56949F', brightMagenta: '#907AA9', brightCyan: '#D7827E', brightWhite: '#575279',
      // xterm's default selection color is a semi-transparent white, which is
      // nearly invisible on this scheme's light background.
      selectionBackground: 'rgba(86, 148, 159, 0.35)',
    },
  },
  {
    // Night Owl (sdras/night-owl-vscode-theme) — via Tabby's community-color-schemes
    // collection.
    id: 'night-owl', name: 'Night Owl', theme: {
      background: '#011627', foreground: '#D6DEEB', cursor: '#80A4C2', cursorAccent: '#011627',
      black: '#011627', red: '#EF5350', green: '#22DA6E', yellow: '#ADDB67',
      blue: '#82AAFF', magenta: '#C792EA', cyan: '#21C7A8', white: '#FFFFFF',
      brightBlack: '#969696', brightRed: '#EF5350', brightGreen: '#22DA6E', brightYellow: '#FFEB95',
      brightBlue: '#82AAFF', brightMagenta: '#C792EA', brightCyan: '#7FDBCA', brightWhite: '#FFFFFF',
    },
  },
  {
    // GitHub's light terminal palette, via Tabby's community-color-schemes collection.
    id: 'github', name: 'GitHub', theme: {
      background: '#F4F4F4', foreground: '#3E3E3E', cursor: '#3F3F3F', cursorAccent: '#F4F4F4',
      black: '#3E3E3E', red: '#970B16', green: '#07962A', yellow: '#F8EEC7',
      blue: '#003E8A', magenta: '#E94691', cyan: '#89D1EC', white: '#FFFFFF',
      brightBlack: '#666666', brightRed: '#DE0000', brightGreen: '#87D5A2', brightYellow: '#F1D007',
      brightBlue: '#2E6CBA', brightMagenta: '#FFA29F', brightCyan: '#1CFAFE', brightWhite: '#FFFFFF',
      // xterm's default selection color is a semi-transparent white, which is
      // nearly invisible on this scheme's light background.
      selectionBackground: 'rgba(0, 62, 138, 0.35)',
    },
  },
  {
    // "Material Dark" — via Tabby's community-color-schemes collection.
    id: 'material-dark', name: 'Material Dark', theme: {
      background: '#232322', foreground: '#E5E5E5', cursor: '#16AFCA', cursorAccent: '#232322',
      black: '#212121', red: '#B7141F', green: '#457B24', yellow: '#F6981E',
      blue: '#134EB2', magenta: '#560088', cyan: '#0E717C', white: '#EFEFEF',
      brightBlack: '#424242', brightRed: '#E83B3F', brightGreen: '#7ABA3A', brightYellow: '#FFEA2E',
      brightBlue: '#54A4F3', brightMagenta: '#AA4DBC', brightCyan: '#26BBD1', brightWhite: '#D9D9D9',
    },
  },
  {
    // Argonaut — via Tabby's community-color-schemes collection.
    id: 'argonaut', name: 'Argonaut', theme: {
      background: '#0E1019', foreground: '#FFFAF4', cursor: '#FF0018', cursorAccent: '#0E1019',
      black: '#232323', red: '#FF000F', green: '#8CE10B', yellow: '#FFB900',
      blue: '#008DF8', magenta: '#6D43A6', cyan: '#00D8EB', white: '#FFFFFF',
      brightBlack: '#444444', brightRed: '#FF2740', brightGreen: '#ABE15B', brightYellow: '#FFD242',
      brightBlue: '#0092FF', brightMagenta: '#9A5FEB', brightCyan: '#67FFF0', brightWhite: '#FFFFFF',
    },
  },
];

export const DEFAULT_COLOR_SCHEMA_ID = 'default';

export function getColorSchema(id: string): ColorSchema {
  return COLOR_SCHEMAS.find((s) => s.id === id) ?? COLOR_SCHEMAS[0];
}

export function getSchemaTheme(id: string): Record<string, string> {
  return getColorSchema(id).theme;
}
