/**
 * Keeps the engine's chrome gate in step with the Canvas overlay (`plan/020` §5).
 *
 * The engine will not emit input lines to a host that draws no popup — otherwise it claims
 * Up/Down/Tab/Enter for a popup rendered inside the OFF-SCREEN pane (design 012 §8.1,
 * `engine.suggest-gate.test.ts`). That flag is normally set by WHERE the surface went, since the
 * pane used to be the only surface with chrome. The overlay is the exception: it renders the
 * popup itself, and opening it moves nothing, so the host has to say so directly.
 *
 * **This exists as its own module because the effect's DEPENDENCIES are the whole feature, and
 * they cannot be tested through `TerminalDisplay`** — that component is unmountable under the
 * root Jest config, so everything about it is asserted by grepping its source. A dependency list
 * is exactly the kind of thing a source grep confirms the shape of and not the meaning of, and
 * the first version of this shipped with a dependency missing:
 *
 *   overlay open on X -> switch to another tab -> `CanvasMode` unmounts -> X relocates to its
 *   pane with `paneChrome: true` -> switch back -> X relocates to the canvas node with
 *   `paneChrome: false`, which ALSO force-closes the popup state (R10).
 *
 * `overlaid` never changed across that round trip — that is precisely what §4 made true by
 * keeping `overlayId` — so an effect keyed on it alone never re-ran, and the overlay came back
 * on screen with its gate shut: `NodeTerminal` still drawing the popup from the published state,
 * the engine silently dropping every input-line update and claiming none of the keys. The
 * drawn-popup-whose-keys-are-not-claimed failure, arrived at from the other direction.
 *
 * So the gate must re-assert on **every relocation edge**, which is what `host` is.
 *
 * It must NOT, however, be restructured into an unconditional
 * `setChromeHostActive(overlaid)` — the tempting one-liner. A terminal sitting in an ordinary
 * pane is not overlaid, and that call would gate its suggestions off for every normal tab in the
 * app. When this terminal is not the overlay the flag belongs to the relocation, and the only
 * correct thing to do is nothing.
 */
import { MutableRefObject, useEffect, useRef } from 'react';

/** The sliver of `TerminalEngine` this hook drives. Narrow on purpose: it keeps the hook
 *  testable against a two-line fake instead of a real xterm. */
export interface ChromeGateEngine {
  setChromeHostActive(active: boolean): void;
}

export interface OverlayChromeGateParams<E extends ChromeGateEngine> {
  engineRef: MutableRefObject<E | null>;
  /** True while this terminal is the Canvas overlay. */
  overlaid: boolean;
  /** The surface host this terminal is currently relocated into, `null` for its own pane.
   *  Present as a DEPENDENCY, not as a value — every change of it is a relocation, and every
   *  relocation overwrites the flag this hook owns. */
  host: HTMLElement | null;
  /** Bumped right after the engine mounts; the only moment `engineRef` is known to hold the
   *  engine belonging to the CURRENT terminalId (H12 / review 098 A1). */
  engineGeneration: number;
  /** Close the popup's React state. The engine stops emitting on its own, but an open popup
   *  would keep drawing in a node that has shrunk back to a thumbnail. */
  closePopup: () => void;
}

export function useOverlayChromeGate<E extends ChromeGateEngine>(
  params: OverlayChromeGateParams<E>,
): void {
  const { engineRef, overlaid, host, engineGeneration } = params;

  // `closePopup` changes identity every render; keeping it out of the deps is what stops a
  // parent re-render from tearing the gate down and putting it back. Same pattern as
  // `useSurfaceRelocation`'s paramsRef.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!overlaid) return;
    // CAPTURED: at cleanup time the ref can already hold a different engine (review 098 A1),
    // and re-gating that one is not this effect's job.
    const engine = engineRef.current;
    engine?.setChromeHostActive(true);
    return () => {
      engine?.setChromeHostActive(false);
      paramsRef.current.closePopup();
    };
    // `engineRef` is a stable ref and `closePopup` lives in paramsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlaid, host, engineGeneration]);
}
