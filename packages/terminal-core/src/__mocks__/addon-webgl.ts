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

  constructor() {
    if (WebglAddon.failNextConstruction) {
      WebglAddon.failNextConstruction = false;
      throw new Error('mock: WebGL context limit reached');
    }
  }

  activate(_term: unknown): void {}
  dispose(): void {}
  onContextLoss(cb: () => void): void {
    WebglAddon.lastContextLossHandler = cb;
  }
}
