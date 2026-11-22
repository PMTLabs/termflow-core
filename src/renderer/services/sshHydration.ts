import type { SshStoreApi } from '../types/ssh';
import { sshErrorMessage } from '../components/Settings/SshConnections/sshErrors';
import { applyView, loadFailed } from '../store/slices/sshSlice';
export function hydrateSsh(api: SshStoreApi | undefined, dispatch: (action: ReturnType<typeof applyView> | ReturnType<typeof loadFailed>) => unknown) {
  let alive = true; let unlisten: (() => void) | undefined;
  const ready = (async () => {
    try {
      if (!api) throw { code: 'desktop-only' };
      const stop = await api.onChanged(reply => { if (alive) dispatch(applyView(reply)); });
      if (!alive) { stop(); return; }
      unlisten = stop;
      const reply = await api.get(); if (alive) dispatch(applyView(reply));
    } catch (error) {
      const failure = error as { code?: string; message?: string } | null;
      if (alive) dispatch(loadFailed({ code: failure?.code, message: sshErrorMessage(error) }));
    }
  })();
  return { ready, stop: () => { alive = false; unlisten?.(); unlisten = undefined; } };
}
