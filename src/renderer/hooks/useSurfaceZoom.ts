import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../store';
import { nudgeZoom, resetZoom, setZoom, ZOOM_DEFAULT } from '../store/slices/zoomSlice';

// OS-aware zoom modifier: Cmd on macOS, Ctrl elsewhere. Matches the modifier the
// terminal engine uses, so zoom feels native on every platform.
const IS_MAC = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
export const isZoomModifier = (e: KeyboardEvent | WheelEvent): boolean =>
  IS_MAC ? e.metaKey : e.ctrlKey;

export interface ZoomControls {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

interface SurfaceZoomOptions {
  // Persist this surface's zoom to app config (survives restart). Terminal panes
  // omit this (ephemeral); the Settings screen sets it true.
  persist?: boolean;
  // Config key used when persist is true. Defaults to the surface key.
  configKey?: string;
}

/**
 * Tracks a single surface's zoom level in the redux `zoom` slice.
 * When `persist` is set, seeds from config on mount and writes back on change.
 */
export function useSurfaceZoom(key: string, opts: SurfaceZoomOptions = {}): ZoomControls {
  const dispatch = useDispatch();
  const zoom = useSelector((s: RootState) => s.zoom.levels[key] ?? ZOOM_DEFAULT);
  const persist = !!opts.persist;
  const configKey = opts.configKey ?? key;

  // Until the persisted value has been read (or determined absent), don't write —
  // otherwise the mount-time default (1.0) would clobber the saved value before
  // we get a chance to load it. This is STATE (not a ref) so that flipping it
  // re-runs the write effect below; otherwise a zoom change made during the async
  // seed window — when no config exists yet — would never get persisted.
  const [seeded, setSeeded] = useState(!persist);

  useEffect(() => {
    if (!persist) return undefined;
    let active = true;
    (async () => {
      try {
        const saved = await window.electronAPI?.getConfigValue?.(configKey);
        if (active && typeof saved === 'number' && saved > 0) {
          dispatch(setZoom({ key, level: saved }));
        }
      } catch {
        // No persisted value / config unavailable — fall back to default.
      } finally {
        if (active) setSeeded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [dispatch, key, persist, configKey]);

  useEffect(() => {
    if (!persist || !seeded) return;
    window.electronAPI?.setConfigValue?.(configKey, zoom);
  }, [zoom, persist, configKey, seeded]);

  const zoomIn = useCallback(() => dispatch(nudgeZoom({ key, direction: 'in' })), [dispatch, key]);
  const zoomOut = useCallback(() => dispatch(nudgeZoom({ key, direction: 'out' })), [dispatch, key]);
  const reset = useCallback(() => dispatch(resetZoom(key)), [dispatch, key]);

  return { zoom, zoomIn, zoomOut, reset };
}

/**
 * Attaches OS-aware zoom gestures (modifier + `=`/`-`/`0` keys and modifier+wheel)
 * to a container element. Container-scoped (capture phase) so it only fires for
 * events targeting this surface — critical because every tab is mounted at once,
 * so a window-level listener would let a hidden surface steal another's zoom.
 */
export function useZoomGestures(
  ref: React.RefObject<HTMLElement | null>,
  controls: ZoomControls,
): void {
  const { zoomIn, zoomOut, reset } = controls;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isZoomModifier(e)) return;
      const { key, code } = e;
      if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
        e.preventDefault();
        e.stopPropagation();
        zoomIn();
      } else if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
        e.preventDefault();
        e.stopPropagation();
        zoomOut();
      } else if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        e.preventDefault();
        e.stopPropagation();
        reset();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!isZoomModifier(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };

    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('keydown', onKeyDown, true);
      el.removeEventListener('wheel', onWheel, true);
    };
  }, [ref, zoomIn, zoomOut, reset]);
}
