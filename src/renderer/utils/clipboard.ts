import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

// Native clipboard access via the Tauri clipboard-manager plugin (Rust-side).
//
// Why not navigator.clipboard: on the WebView origin (http://localhost:42010 in
// dev), Chromium/WebView2 treats navigator.clipboard.readText() as a permission-
// gated action and shows the "<origin> wants to see text and images copied to the
// clipboard" popup. Reading natively through Tauri avoids that prompt entirely.
//
// Both helpers fall back to navigator.clipboard if the native call fails (e.g. a
// non-Tauri host), so they remain safe in any environment.

export async function readClipboardText(): Promise<string> {
  try {
    const text = await readText();
    return text ?? '';
  } catch (err) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
    } catch {
      /* ignore — fall through to empty */
    }
    console.error('clipboard: native read failed', err);
    return '';
  }
}

export function writeClipboardText(text: string): void {
  void writeText(text).catch(async (err) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* ignore */
    }
    console.error('clipboard: native write failed', err);
  });
}
