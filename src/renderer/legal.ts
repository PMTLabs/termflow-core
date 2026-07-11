// Legal / agreements config for the app.
//
// - Bundled docs live under `legal/` in the repo and are shipped as Tauri resources
//   (see bundle.resources in tauri.conf.json / tauri.pro.conf.json). Read them at runtime
//   via `window.electronAPI.readLegalDocument(file)`.
// - The public site (https://termflow.app) is the canonical home for human-readable terms.
//   `/licenses` is live; `/terms` and `/privacy` are not published yet, so those links are
//   gated by `isLive` (mirrors the site's own pattern) and simply hidden until they exist.

/** Canonical public site (from termflow-site seo.ts ORIGIN). */
export const SITE_ORIGIN = 'https://termflow.app';

/** Bump when the EULA text materially changes — the acceptance modal re-appears for
 *  everyone whose stored `eulaAcceptedVersion` differs. Keep in sync with legal/EULA.txt. */
export const CURRENT_EULA_VERSION = '1.0';

/** Config key under which acceptance is persisted in config.json. */
export const EULA_ACCEPTED_KEY = 'eulaAcceptedVersion';

export interface LegalLink {
    label: string;
    url: string;
    /** False until the site actually publishes the page — the link is hidden meanwhile. */
    live: boolean;
}

/** Links to the canonical online versions. `live:false` hides a link until the site ships
 *  that page (so the app never shows a dead link). All three pages now exist on the site. */
export const LEGAL_LINKS: LegalLink[] = [
    { label: 'Licenses & attribution', url: `${SITE_ORIGIN}/licenses`, live: true },
    { label: 'Terms of Service', url: `${SITE_ORIGIN}/terms`, live: true },
    { label: 'Privacy Policy', url: `${SITE_ORIGIN}/privacy`, live: true },
];

export const isLive = (l: LegalLink): boolean => l.live && l.url.startsWith('http');

export interface BundledDoc {
    /** Filename as bundled under legal/ and accepted by `read_legal_document`. */
    file: string;
    title: string;
    /** Only present in Pro builds (bundles the peering fabric); read may fail otherwise. */
    proOnly?: boolean;
}

/** The documents bundled into the app, shown in Settings → About & Legal. */
export const BUNDLED_DOCS: BundledDoc[] = [
    { file: 'EULA.txt', title: 'End-User License Agreement' },
    { file: 'PRIVACY.txt', title: 'Privacy Notice' },
    { file: 'LICENSE-apache-2.0.txt', title: 'Open-Source Core License (Apache-2.0)' },
    { file: 'LICENSE-fabric-fsl.txt', title: 'Peering Fabric License (FSL-1.1-Apache-2.0)', proOnly: true },
    { file: 'THIRD-PARTY-NOTICES.txt', title: 'Third-Party Notices' },
];
