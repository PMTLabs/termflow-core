// Fake @xterm/addon-webgl for jsdom unit tests — real WebGL addon needs a GPU canvas
// context that jsdom lacks.
export class WebglAddon {
  activate(_term: unknown): void {}
  dispose(): void {}
  onContextLoss(_cb: () => void): void {}
}
