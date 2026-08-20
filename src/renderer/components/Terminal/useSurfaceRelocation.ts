/**
 * Move a terminal's rendered surface between its pane and a registered canvas
 * host, in the pre-paint flush (design 012 §4.2.1 + §4.2.2).
 *
 * Extracted from TerminalDisplay so the ordering guarantees below are unit
 * testable: TerminalDisplay cannot be mounted under the root Jest config (two CSS
 * imports with no transform, @tauri-apps/api/event, the Redux store, and a real
 * xterm Terminal.open() that needs a canvas 2D context jsdom lacks). The semantics
 * are exactly the spec's — same useLayoutEffect, same [host, engineGeneration]
 * deps, same captured engine and pane, same identity-guarded cleanup.
 *
 * WHY `engineGeneration` (hazard H12, MEASURED by spike 004 Q1). A relocation
 * useLayoutEffect keyed `[host]` alone runs BEFORE the passive useEffect that
 * creates the engine — all layout effects for a commit fire before any passive
 * effect, unconditionally — so on the mount commit it sees a null ref, and if
 * nothing about `host` changes afterwards it NEVER gets a second chance.
 * Relocation-at-mount is then unreachable, which is a shipping defect on the paths
 * the design names: a pane-collapse remount while displayed on canvas, a
 * cross-window detach, a webview reload with canvas mode active. Bumping a
 * useState token from the engine effect forces a second commit — React flushes it
 * synchronously before paint — and this effect re-fires with the ref populated.
 *
 * `terminalId` is deliberately NOT in the deps (review 094 B1's second suggestion,
 * declined with a reason): a terminalId change re-runs this effect on the new
 * commit, which still runs before the new engine's passive effect, so it hits the
 * same null ref. `engineGeneration` covers terminalId TRANSITIVELY, because the
 * engine effect that bumps it is itself keyed [terminalId]. One dep, not two, and
 * it is the one that actually corresponds to the precondition being waited on.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useSurfaceHost } from '../../services/surfaceHosts';

/** The slice of TerminalEngine this hook needs. Structural, so the hook has no
 *  dependency on terminal-core and the tests can drive a fake. */
export interface RelocatableEngine {
  relocateTo(
    container: HTMLElement,
    opts?: { paneChrome?: boolean },
  ): 'relocated' | 'aborted';
}

export interface SurfaceRelocationParams<E extends RelocatableEngine> {
  /** The renderer LEAF id — the surface-host registry key (design 012 §9 C3). */
  terminalId: string;
  engineRef: RefObject<E | null>;
  /** The pane's `.terminal-display` div: the implicit fallback host. */
  paneRef: RefObject<HTMLElement | null>;
  /** Fired after a successful relocation. `toCanvas` is true when the surface just
   *  left the pane, so the caller can close pane chrome that no longer applies. */
  onRelocated: (toCanvas: boolean) => void;
  /** Fired when relocateTo returned 'aborted'. The engine is fully restored
   *  (design 012 §5.1); the caller's job is to tell the user. */
  onAborted: () => void;
}

export function useSurfaceRelocation<E extends RelocatableEngine>(
  params: SurfaceRelocationParams<E>,
): { engineMounted: () => void; engineGeneration: number; host: HTMLElement | null } {
  const { terminalId, engineRef, paneRef } = params;
  const host = useSurfaceHost(terminalId);
  const [engineGeneration, setEngineGeneration] = useState(0);

  // The callbacks change identity every render; keep them out of the deps so a
  // parent re-render cannot re-run the move. Same pattern as
  // TerminalDisplay's onTitleChangeRef (TerminalDisplay.tsx:153-154).
  const paramsRef = useRef(params);
  paramsRef.current = params;

  /** Call from the engine effect, right after mount(), so this hook can re-run
   *  against a ref that is finally populated (H12). Stable identity. */
  const engineMounted = useCallback(() => {
    setEngineGeneration((g) => g + 1);
  }, []);

  useLayoutEffect(() => {
    // CAPTURED, both of them, in the effect BODY.
    //  - `engine`: engineRef.current at CLEANUP time can be a DIFFERENT engine
    //    (review 098 A1) — TerminalDisplay is rendered without a key
    //    (TerminalPane.tsx:713-…) and TerminalPane's reuse path lets terminalId
    //    change on the same component instance (TerminalPane.tsx:174-201).
    //  - `pane`: on a whole-component deletion React detaches host refs
    //    (ref.current = null) during the deletion traversal, BEFORE passive
    //    cleanup (review 099 T1-F3), so re-reading the ref at cleanup time yields
    //    null and the cleanup silently does nothing.
    const engine = engineRef.current;
    const pane = paneRef.current;
    if (!engine || !pane) return;          // covered by engineGeneration
    const target = host ?? pane;
    const result = engine.relocateTo(target, { paneChrome: !host });
    if (result === 'aborted') {
      paramsRef.current.onAborted();
      return;                              // engine state fully restored by R0/§5.1
    }
    paramsRef.current.onRelocated(!!host);
    return () => {
      // Return the surface to the pane BEFORE the canvas host can leave the
      // document. Free (an R0 identity no-op) whenever the element is already home.
      //
      // The identity guard, not merely the capture: without it the captured OLD
      // engine — already unmount()ed by the engine effect's own cleanup, but still
      // holding a live term — would appendChild its element into the pane div the
      // SUCCESSOR has already mounted into, putting two xterm elements in one host
      // (hazard H13). Skipping is safe because the engine effect's cleanup has
      // already relocated that engine home, unconditionally, before unmount().
      if (engineRef.current !== engine) return;
      engine.relocateTo(pane, { paneChrome: true });
    };
    // `engineRef`/`paneRef` are stable refs and the callbacks live in paramsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, engineGeneration]);

  // Both of these are exposed as well as consumed (`plan/020` §5), and together they are "the
  // relocation state" — the two things any OTHER effect that configures the engine has to
  // re-run on, because this hook's own effect re-runs on exactly them:
  //
  //  - `engineGeneration` is the only signal that `engineRef.current` is populated AND is the
  //    engine belonging to the CURRENT terminalId (the H12 / review 098 A1 hazard above).
  //  - `host` changing IS a relocation, and `relocateTo({ paneChrome: !host })` overwrites the
  //    chrome flag from its own argument. An effect that owns that flag and does not watch this
  //    is silently overruled on every canvas round trip.
  return { engineMounted, engineGeneration, host };
}
