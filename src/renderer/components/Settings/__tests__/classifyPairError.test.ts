/**
 * Contract tests for the Add-Peer error classifier.
 *
 * Every `raw` string below is the REAL message the core now produces — `control_err`
 * prefixes the command name and appends the fabric's own `{"error": ...}` reason, which
 * originates in `termflow-fabric`'s `peer_server.rs` / `peer_client.rs`. That contract is
 * the whole point of these tests: the classifier's substrings were previously written
 * against guessed wording ("not accepting", "rejected pairing") that the fabric never
 * emits, so the branches could not fire — and it did not matter anyway, because the core
 * dropped the fabric's body and every failure arrived as "fabric returned 502 Bad Gateway".
 * If the fabric rewords an error, one of these fails instead of the panel silently
 * degrading to a raw string in front of a user.
 */
import { classifyPairError } from '../AddPeerModal';

describe('classifyPairError', () => {
    it('tells the user to enable Accept peers when the remote refuses pairing', () => {
        // peer_server::pair_start_handler → 403 when accept_peers is off. This is the exact
        // failure that surfaced as an unactionable "502 Bad Gateway".
        const raw =
            'peer_add: pairing rejected: 403 Forbidden: {"error":"pairing not enabled"}';
        expect(classifyPairError(raw)).toMatch(/isn’t accepting peers/i);
        expect(classifyPairError(raw)).toMatch(/Accept incoming peer connections/i);
    });

    it('names the port to open when the address is unreachable', () => {
        const raw =
            'peer_add: http: error sending request for url (https://10.0.3.10:8790/pair/start): connection refused';
        const msg = classifyPairError(raw, 8790);
        expect(msg).toMatch(/couldn’t reach that address on port 8790/i);
        expect(msg).toMatch(/firewall/i);
    });

    it('falls back to the default port when the fabric reported none', () => {
        expect(classifyPairError('peer_add: http: connection refused')).toContain('8790');
    });

    it('treats a failed key confirmation as a bad code, not a crypto scare', () => {
        // The code never crosses the wire, so a WRONG code surfaces as this.
        const raw =
            'peer_add: pairing rejected: 401 Unauthorized: {"error":"key confirmation failed"}';
        expect(classifyPairError(raw)).toMatch(/pairing code was rejected/i);
    });

    it.each([
        ['invalid or expired code', 401],
        ['pairing code expired or was replaced', 403],
        ['no pairing in progress', 401],
        ['invalid pairing message', 400],
    ])('classifies %s as a code problem', (reason, status) => {
        const raw = `peer_add: pairing rejected: ${status}: {"error":"${reason}"}`;
        expect(classifyPairError(raw)).toMatch(/pairing code was rejected/i);
    });

    it.each([
        'too many pairing attempts from this identity',
        'too many in-flight pairings; try again shortly',
    ])('classifies %s as rate limiting, distinct from a bad code', (reason) => {
        const raw = `peer_add: pairing rejected: 429: {"error":"${reason}"}`;
        expect(classifyPairError(raw)).toMatch(/rate-limiting/i);
    });

    it('reports a local fabric that is down separately from an unreachable peer', () => {
        // control_err's connect arm — our own sidecar, not the remote.
        const raw = 'peer_add: peering fabric is not running (connection refused)';
        expect(classifyPairError(raw)).toMatch(/isn’t running on this machine/i);
    });

    it('passes an unrecognized message through rather than inventing guidance', () => {
        expect(classifyPairError('peer_add: something entirely new')).toBe(
            'peer_add: something entirely new',
        );
    });

    it('never renders an empty error', () => {
        expect(classifyPairError('')).toBe('Pairing failed. Please try again.');
    });
});
