// Fake @xterm/addon-webgl for jsdom unit tests — real WebGL addon needs a GPU canvas
// context that jsdom lacks.
export class WebglAddon {
  /**
   * Test switch: when true, the NEXT construction throws and resets this to false.
   * Models a real promotion failure (GPU context limit, driver refusal), which
   * design/013 D3/D7 require to be REPORTED rather than thrown. Without it the
   * failure branch of setTerminalRenderPolicy is unreachable from a test.
   */
  static failNextConstruction = false;

  /** Captured so a test can fire a context loss without a real GPU. Cleared on
   *  dispose — see `contextLossListeners`. */
  static lastContextLossHandler: (() => void) | null = null;

  /**
   * Every instance ever constructed, in construction order. design/013 §4.2 (FA)
   * and §5.2 (ORPHAN) are both statements about INSTANCES — "a fresh addon every
   * promotion", "every live addon is reachable from the cache" — so the tests need
   * the instances, not just the entry fields. Suites that assert on this reset it
   * in their own afterEach.
   */
  static instances: WebglAddon[] = [];

  /** Per-instance, so a test can see whether the addon it is holding was disposed.
   *  §6.1 item 1 stands: this proves our dispose() was CALLED, never that a GPU
   *  context was released — the mock has no context to release. */
  disposed = false;

  /**
   * The instance's own context-loss listeners, and the reason they are per-instance
   * and CLEARED BY dispose() (rev 15, codex round 7 MEDIUM).
   *
   * In the real `@xterm/addon-webgl@0.19.0`, `onContextLoss` is an `Emitter` created
   * with `this._register(...)` — it belongs to the addon's own `DisposableStore`. So
   * `dispose()` tears the emitter down, and xterm's `DisposableStore.clear()` does
   * `try { dispose(children) } finally { this._toDispose.clear() }` — meaning the
   * store is emptied EVEN WHEN A CHILD THROWS.
   *
   * The consequence is the whole point: once `dispose()` has been attempted, no
   * later GPU context loss can ever deliver our callback. An addon only ever reaches
   * the quarantine BY a dispose() that threw — so for a quarantined addon the
   * context-loss release path is already dead. The mock previously left the callback
   * callable forever, which let two tests certify a recovery path that cannot happen.
   */
  contextLossListeners: Array<() => void> = [];

  constructor() {
    if (WebglAddon.failNextConstruction) {
      WebglAddon.failNextConstruction = false;
      throw new Error('mock: WebGL context limit reached');
    }
    WebglAddon.instances.push(this);
  }

  activate(_term: unknown): void {}
  dispose(): void {
    this.disposed = true;
    // Model the real DisposableStore teardown: the emitter goes with the addon, and
    // it goes even if some other child of the store throws on the way out.
    this.contextLossListeners.length = 0;
    if (WebglAddon.lastContextLossHandler && this.ownsLastHandler) {
      WebglAddon.lastContextLossHandler = null;
    }
  }

  /** True when the most recently registered handler belongs to THIS instance. */
  private ownsLastHandler = false;

  onContextLoss(cb: () => void): void {
    this.contextLossListeners.push(cb);
    WebglAddon.lastContextLossHandler = cb;
    this.ownsLastHandler = true;
  }

  /** Fire a context loss the way the real addon would — a no-op once disposed. */
  fireContextLoss(): void {
    for (const cb of [...this.contextLossListeners]) cb();
  }
  clearTextureAtlas(): void {}
}
