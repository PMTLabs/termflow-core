type PendingCall = {
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

/** Install command(name) on a mocked bridge; no call settles automatically. */
export function gatedBridge() {
  const pending = new Map<string, PendingCall[]>();
  const get = (name: string, index: number) => {
    const call = pending.get(name)?.[index];
    if (!call || call.settled) throw new Error(`No pending ${name} call at ${index}`);
    call.settled = true;
    return call;
  };
  return {
    command: (name: string) => (...args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const calls = pending.get(name) ?? [];
        calls.push({ args, resolve, reject, settled: false });
        pending.set(name, calls);
      }),
    calls: (name: string): unknown[][] => (pending.get(name) ?? []).map(call => call.args),
    release: (name: string, index = 0, value?: unknown) => get(name, index).resolve(value),
    fail: (name: string, index = 0, reason?: unknown) => get(name, index).reject(reason),
  };
}
