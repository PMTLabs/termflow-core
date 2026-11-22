import { installPaneIncarnations, PaneIncarnations, type PaneBridge } from '../services/paneIncarnations';

/** Immediate page stream for workspace tests that do not exercise ownership refusal. */
export function installRestoreStream(): PaneIncarnations {
  const bridge = (async (command: string) => {
    if (command === 'register_page') return { status: 'Registered', wi: 1, pg: 1 };
    return { status: 'Ack', result: { status: 'Ok' } };
  }) as PaneBridge;
  const client = new PaneIncarnations(bridge);
  installPaneIncarnations(client);
  return client;
}
