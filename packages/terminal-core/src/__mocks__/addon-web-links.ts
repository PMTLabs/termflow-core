// Fake @xterm/addon-web-links for jsdom unit tests.
export class WebLinksAddon {
  activate(_term: unknown): void {}
  dispose(): void {}
}
