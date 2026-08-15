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

  /** Captured so a test can fire a context loss without a real GPU. */
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
  }
  onContextLoss(cb: () => void): void {
    WebglAddon.lastContextLossHandler = cb;
  }
  clearTextureAtlas(): void {}
}
