// Fake @xterm/addon-unicode11 for jsdom unit tests.
export class Unicode11Addon {
  activate(_term: unknown): void {}
  dispose(): void {}
}
