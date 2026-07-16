# Terminal Text Contrast & Color Schemes

How TermFlow renders terminal foreground/dim text, why "dim" text (subtitles,
paths, secondary CLI output) used to look too dark on macOS/dark themes, the
fix that's in place now, and how to add a new color scheme without
reintroducing the problem.

## The symptom

On dark schemes, bold/plain text (e.g. a CLI's title line) looked fine, but
adjacent "dim"/"faint" text (SGR `\x1b[2m` — subtitles, file paths,
timestamps, muted CLI output) looked noticeably darker than the surrounding
UI, even after repeatedly brightening each scheme's `foreground` color.

## Root cause

xterm.js renders SGR-dim text as a **hardcoded 50% opacity blend of the
resolved foreground color toward the cell's background** — it is not a
separate palette color, it is not related to `brightBlack`, and (in v6) there
is no `Terminal` option to change the blend factor itself.

That alone puts a hard ceiling on a pure-black-background scheme: even with
foreground pushed to pure white, dim text can never render brighter than
`#808080` (50% gray blended into `#000000`), no matter how many times the
scheme's `foreground` value is bumped. This is why several rounds of manually
brightening `foreground` (`#cccccc` → `#e8e8e8` → `#efefef` → `#f2f2f2`)
produced diminishing, and eventually invisible, returns.

## The real fix: patch xterm's dim-opacity factor

The clean fix is to change the `0.5` factor itself. It is not exposed as an
option, so TermFlow patches the published `@xterm` bundles in `node_modules`
directly, raising the factor to **`0.70`**:

- **Script:** `patches/xterm-dim-patch.js` (modeled on `patches/node-pty-patch.js`).
- **Wired to `postinstall`** in `package.json` (and available as
  `bun run patch:xterm-dim`), so it re-applies automatically after every
  `bun install`. The script is idempotent (re-running is a no-op) and fails
  loudly if the expected tokens are missing — which is the signal that an
  `@xterm/xterm` or `@xterm/addon-webgl` version bump reminified the bundle
  and the token patterns in the script need re-verifying.
- **What it edits:** the dim blend in all three render paths so they stay
  consistent — the DOM/canvas renderer's runtime blend plus its precomputed
  half-bright foreground/ANSI colors (`multiplyOpacity(x, .5)` → `.70` in
  `lib/xterm.mjs` + `lib/xterm.js`), and the WebGL addon's dim factor
  (`gn`/`DIM_OPACITY` `.5` → `.70` in `addon-webgl.mjs` + `addon-webgl.js`).
  The script matches ANY current decimal factor, so bumping the value is just an
  edit to `NEW_FACTOR` + re-run (no need to reinstall to a pristine `.5` first).

`0.70` renders dim text at ~6.7–8.9:1 on the dark schemes (near WCAG AAA) and
~5.1–6.0:1 on the light ones, while it stays visibly dimmer than full-strength
foreground (11–19:1) — the iTerm2-style faint look. To retune, change
`NEW_FACTOR` in the script (0.5 = xterm default, higher = brighter/less dim)
and re-run it, then rebuild the renderer.

Because the patch edits `node_modules`, the running dev server won't see it
until a **full `bun run dev` restart** (webpack bundles xterm at startup and
does not watch `node_modules` — same gotcha as the terminal-core note below).

Everything below (`minimumContrastRatio`, the brightened `foreground` values)
predates this patch. It is kept because it is still a valuable safety net for
non-dim low-contrast pairs, but the dim-opacity patch — not these — is now
what makes dim text itself readable.

## Earlier mitigation: `minimumContrastRatio`

xterm.js supports `Terminal.options.minimumContrastRatio`
(`node_modules/@xterm/xterm/typings/xterm.d.ts`) — it dynamically brightens
(or darkens) the **final resolved color** of any cell whose contrast against
the background falls below the target ratio. TermFlow sets it to **`4.5`**
(WCAG AA) in the shared `Terminal` constructor
(`packages/terminal-core/src/TerminalEngine.ts`). Its original purpose is to
keep prompt-painted background colors readable (e.g. the stock Debian/Ubuntu
zsh prompt's `%K{blue}...%k` against a light foreground), and it also lifts
low-contrast secondary text (`brightBlack`, SGR 90) up to AA.

### Why NOT crank it up to "fix" dim text (the trap we fell into)

It is tempting to reach for a high `minimumContrastRatio` to force dim text
brighter. **Don't** — it destroys color. Two reasons:

1. **It caps at pure white/black.** When a cell's color can't reach the target
   contrast, xterm forces it all the way to white (on dark bg) or black (on
   light bg), erasing its hue. On a not-quite-black background the maximum
   achievable contrast is limited — Sunset (`#3B2C35`) tops out at **13.1:1**,
   Nord at **12.5:1** — so a target of `14` makes *every* colored cell
   unreachable and collapses the whole palette to a flat washed-out white.
   (This actually shipped briefly and produced exactly that bug: all prompt
   colors lost.)

2. **The dim target is halved anyway.** Found by reading xterm's renderer
   source (`_applyMinimumContrast`, CellColorResolver): the target is halved
   for any dim cell — `minimumContrastRatio / (isDim() ? 2 : 1)`. So `14`
   only buys dim text a `7:1` floor while charging normal text the full,
   palette-destroying `14:1`. There is no single value that makes dim text
   AAA-bright *and* keeps colors — they are in direct conflict.

**So dim text is NOT this option's job.** Dim-text legibility comes from each
scheme's brightened `foreground` instead: dim renders as a fixed 50% blend of
foreground toward background, which lands around **4.2–4.8:1** (AA) on the
dark schemes on its own, with zero effect on any colored text. That is why the
`DEFAULT_THEME`/`COLOR_SCHEMAS` `foreground` values were brightened (see
below) — they, not `minimumContrastRatio`, carry dim-text readability.

## Where the colors live

- `packages/terminal-core/src/TerminalEngine.ts` — `DEFAULT_THEME` (the
  "Default" scheme) and the `minimumContrastRatio`/`drawBoldTextInBrightColors`
  Terminal options, both in the `new Terminal({...})` constructor block.
- `src/renderer/store/colorSchemas.ts` — `COLOR_SCHEMAS`, the full list of
  selectable schemes (Settings → color scheme picker). Each entry is an xterm
  `ITheme`-shaped object (`background`/`foreground`/`cursor`/16 ANSI colors,
  optionally `selectionBackground`).

Several schemes (Dracula, Nord, Solarized, Monokai, Gruvbox, One Dark,
Ubuntu, Tokyo Night, Rosé Pine, Night Owl, GitHub, Material Dark, Argonaut)
are explicitly sourced byte-for-byte from their official published palettes
for authenticity. Their `foreground` values were deliberately brightened
anyway (contrast was prioritized over exact upstream fidelity, at explicit
user request) — everything else in those palettes (background, ANSI accent
colors) is untouched.

## Adding a new color scheme

1. Add an entry to `COLOR_SCHEMAS` in `src/renderer/store/colorSchemas.ts`
   (`{ id, name, theme: {...} }`). It shows up in Settings automatically —
   nothing else needs to be wired up (`ColorSchemaGrid.tsx` maps over the
   array dynamically).
2. Pick a `background` and design every other color to clear **at least
   4.5:1 (WCAG AA)** contrast against it. `minimumContrastRatio` (above) will
   dynamically rescue text that falls short at runtime, but don't rely on it
   as your only line of defense — a scheme whose *static* values already
   pass AA reads correctly even if that option is ever changed or disabled.
3. Verify with a quick script rather than eyeballing hex codes — relative
   luminance / contrast ratio (WCAG formula), e.g.:

   ```js
   function luminance([r,g,b]) {
     const lin = c => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
     const [R,G,B] = [r,g,b].map(lin);
     return 0.2126*R + 0.7152*G + 0.0722*B;
   }
   function contrastRatio(l1, l2) {
     const [a,b] = l1>l2 ? [l1,l2] : [l2,l1];
     return (a+0.05)/(b+0.05);
   }
   ```

   `black` is a deliberate exception: every existing dark scheme keeps it
   close to (or darker than) `background` (contrast ~1:1) — that's standard
   ANSI-theme convention, not a bug, so don't force it to 4.5:1. Every other
   slot, including `brightBlack` (the dim/secondary-text gray most CLIs
   actually use), should clear the bar.

   Run every ANSI slot (`black`..`brightWhite`, `foreground`) against
   `background`; darken/brighten anything under 4.5:1 until it clears the
   bar. This is exactly how the `sunrise` scheme's palette was verified.
4. Light-background schemes (background luminance > 0.5) need *dark*
   foreground/ANSI colors for contrast — the opposite direction from dark
   schemes. Don't reuse a dark scheme's brighten-toward-white approach on a
   light one.
5. If the background isn't pure black or pure white, xterm's default
   semi-transparent-white selection color can become nearly invisible —
   add an explicit `selectionBackground` (see `solarized-light`, `tomorrow`,
   `github`, etc. for the pattern: the scheme's own accent color at ~25-35%
   alpha).

## Important: rebuilding `packages/terminal-core`

`@termflow/terminal-core` is a separate Bun workspace package, built to
`packages/terminal-core/dist/` and consumed by the renderer via a symlink
(`node_modules/@termflow/terminal-core` → `packages/terminal-core`).
**Webpack's dev server does not watch `node_modules` by default**, so once
`bun run dev` is running, editing `packages/terminal-core/src/*.ts` and even
rebuilding it (`bun run build:terminal-core`) has **no effect on the running
app** — the dev server keeps serving whatever it originally bundled.

`tauri.conf.json`'s `beforeDevCommand` (`bun run build:terminal-core && npm
run dev:renderer`) does rebuild the package, but only runs once, at process
start. Any change to `packages/terminal-core` while `bun run dev` is already
running requires **fully quitting the app and running `bun run dev` again**
— not a window reload, not `tauri dev`'s hot-reload, a full process restart.
This caused significant confusion while diagnosing the contrast issue: three
rounds of substantially different `foreground` values produced *zero*
visible change until the dev process was actually restarted.
