# legal/ — bundled agreements & notices

These files are **bundled into the app** (`bundle.resources` in `src-tauri/tauri.conf.json` /
`tauri.pro.conf.json`) and shown in-app via **Settings → About & Legal** and the first-run
**EULA acceptance modal**. `EULA.rtf` is also the installer license page (`bundle.licenseFile`).

| File | What it is | Status |
|---|---|---|
| `EULA.txt` / `EULA.rtf` | End-User License Agreement / Terms — what the user accepts at first run + install | **Official v1.0** (PMT Labs LLC; Texas law). `EULA.rtf` is generated from `EULA.txt` by `scripts/gen-eula-rtf.mjs` |
| `PRIVACY.txt` | Privacy notice | **Official v1.0** (PMT Labs LLC) |
| `LICENSE-apache-2.0.txt` | Apache-2.0 — the open-core license | Real (canonical Apache-2.0) |
| `LICENSE-fabric-fsl.txt` | FSL-1.1-Apache-2.0 — the Pro peering fabric's license | Copied at build time from `termflow-fabric/LICENSE` by `scripts/build-fabric-sidecar.mjs` (Pro builds only) |
| `THIRD-PARTY-NOTICES.txt` | Open-source attribution for bundled deps | **Generated** by `scripts/gen-third-party-notices.mjs` from the real Rust + JS dependency trees. Regenerate before release: `npm run gen:third-party-notices` (or `node scripts/gen-third-party-notices.mjs`). Includes the Pro fabric's Rust deps when the fabric source is present. |

> The EULA and Privacy Notice are the official published v1.0 terms of PMT Labs LLC (governing
> law: Texas, USA; contacts legal@ / privacy@termflow.app). They are AI-drafted from the
> business's stated facts and adopted by PMT Labs LLC; a one-time review by counsel is still
> recommended. **Editing `EULA.txt`?** Re-run `node scripts/gen-eula-rtf.mjs` and bump
> `CURRENT_EULA_VERSION` in `src/renderer/legal.ts` (currently `1.0`).

## Canonical online versions
The public site is the source of truth for human-readable legal text:
- **Licenses / attribution:** `https://termflow.app/licenses` (live)
- **Terms / Privacy:** not published on the site yet — the in-app links to `/terms` and `/privacy`
  are gated (hidden until live) via `src/renderer/legal.ts` `isLive()`. When the site publishes
  those pages, flip them live there and the app links light up automatically.

## Generating THIRD-PARTY-NOTICES.txt (before release)
- **One command:** `npm run gen:third-party-notices` (`node scripts/gen-third-party-notices.mjs`).
  It reads the real dependency trees — `cargo metadata` for the core (`src-tauri`) and, when the
  fabric source is present, the peering fabric; and `bunx license-checker --production` for the
  renderer — and reproduces each component's license text from its own source. Regenerate
  whenever dependencies change; it is committed so a plain `tauri build` bundles it as-is.
- The last run produced ~973 components. A small number of Rust crates ship no LICENSE file in
  their source; those are listed with their declared SPDX license and no reproduced text.
- Recommended (not yet wired): a `deny.toml` license allow-list in CI so an unexpected/copyleft
  license fails the build.

## Updating the EULA
Bump `CURRENT_EULA_VERSION` in `src/renderer/legal.ts` whenever the EULA materially changes —
the acceptance modal re-appears for everyone until they accept the new version (stored in
`config.json` as `eulaAcceptedVersion`).
