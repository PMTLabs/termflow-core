// Renderer-only transport fixture. Rust tests exercise the actual state machine;
// this fixture supplies window-qualified replies and separately gated host requests.
export function makeBindingHost() {
  const shells = new Map<string, { holder?: string; process?: string; creating: boolean; closed: boolean }>();
  const finishing = new Map<string, () => void>();
  const frames: Array<{ window: string; kind: string; leaf: string }> = [];
  const closed: string[] = [];
  const seed = (leaf: string, process: string, holder?: string) => shells.set(leaf, { holder, process, creating: false, closed: false });
  const apiFor = (label: string) => ({
    createTerminal: jest.fn((_p, _n, _c, leaf: string) => {
      const old = shells.get(leaf);
      if (old?.creating) return Promise.reject(new Error(`host-ownership-pending: ${leaf} create running`));
      if (old?.process && !old.closed) return Promise.reject(new Error(`host-session-contended: ${leaf} registered`));
      const shell = { holder: label as string | undefined, process: undefined as string | undefined, creating: true, closed: false };
      shells.set(leaf, shell);
      frames.push({ window: label, kind: 'Attach', leaf });
      return new Promise<string>((resolve, reject) => {
        finishing.set(leaf, () => {
          shell.creating = false;
          shell.process = 'pc-old-host';
          if (shell.closed) {
            closed.push(shell.process);
            shell.process = undefined;
            reject(new Error('shell closed while create was running'));
          } else resolve(shell.process);
        });
      });
    }),
    bindShell: jest.fn(async (leaf: string, expected?: string) => {
      const shell = shells.get(leaf);
      if (!shell || shell.closed) return { status: 'none' as const };
      if (shell.creating) return { status: 'pending' as const };
      if (shell.holder && shell.holder !== label) return { status: 'refused' as const };
      if (!shell.process || (expected && shell.process !== expected)) return { status: 'none' as const };
      shell.holder = label;
      return { status: 'bound' as const, processId: shell.process };
    }),
    releaseShellBinding: jest.fn(async (leaf: string) => {
      const shell = shells.get(leaf);
      if (shell?.holder === label) shell.holder = undefined;
    }),
    forgetRestoringLeaf: jest.fn(async (leaf: string) => {
      const shell = shells.get(leaf);
      if (!shell) return;
      shell.closed = true;
      shell.holder = undefined;
      if (shell.process) { closed.push(shell.process); shell.process = undefined; }
    }),
    closeTerminal: jest.fn(async () => {}),
    adoptConsoleWindow: jest.fn(async () => {}),
  });
  return { apiFor, seed, frames, closed, complete: (leaf: string) => finishing.get(leaf)!(),
    isCreating: (leaf: string) => shells.get(leaf)?.creating === true,
    holder: (leaf: string) => shells.get(leaf)?.holder };
}
