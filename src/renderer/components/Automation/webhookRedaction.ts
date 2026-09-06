/**
 * Last-resort display redaction for text returned across the automation IPC boundary.
 *
 * The Rust producers avoid constructing URL-bearing errors, but a corrupt historical log entry or
 * a framework-level decode failure must not make the webhook endpoint visible in a toast, inspector,
 * activity row, or clipboard export.
 */
import type { AutomationLogEntry } from '../../types/electron';

export const REDACTED_WEBHOOK_URL = '<redacted webhook URL>';

const WEBHOOK_URL = /\bhttps?:\/\/[^\s<>"'\\]+/giu;

export function redactWebhookText(value: string): string {
    return value.replace(WEBHOOK_URL, REDACTED_WEBHOOK_URL);
}

export function redactWebhookError(error: unknown): string {
    return redactWebhookText(error instanceof Error ? error.message : String(error));
}

/** Redact every serialised activity field that can reach a display or export surface. */
export function redactWebhookLogEntry(entry: AutomationLogEntry): AutomationLogEntry {
    return {
        ...entry,
        ruleId: redactWebhookText(entry.ruleId),
        terminalId: entry.terminalId == null ? entry.terminalId : redactWebhookText(entry.terminalId),
        terminalName: entry.terminalName == null ? entry.terminalName : redactWebhookText(entry.terminalName),
        detail: redactWebhookText(entry.detail),
    };
}
