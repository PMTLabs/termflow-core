/**
 * The one way renderer consumers read a capture record.
 *
 * Capture names originate in a user-authored pattern, while records are ordinary JavaScript
 * objects. Looking up a missing `toString` or `constructor` directly would therefore read an
 * inherited member rather than the absent capture Rust represents as `None`.
 */
export function captureText(captures: Record<string, string>, key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(captures, key) ? captures[key] : undefined;
}
