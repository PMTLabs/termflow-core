/**
 * §10.23 — `AuActivityPane` reads only what was stored.
 *
 * **Source-derived, because the defect is invisible in the output.** A display-time name lookup
 * looks right for every live terminal and wrong only for the rows that matter: the
 * `failed — the terminal closed` line is written *after* the terminal is gone, so a lookup returns
 * nothing for exactly the row the column exists to serve — and a rename would silently rewrite every
 * past line. A rendering test would need a closed terminal AND a renamed one to see it; this needs
 * neither.
 *
 * That is R17 expressed as a test rather than a comment.
 *
 * *(`readSource` rather than raw `fs`: the e2e job has no OS label, so a checkout may be CRLF, and a
 * pattern containing a literal newline silently becomes `-1` there —
 * `source-derived-tests-break-on-crlf`.)*
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const FILE = path.join(__dirname, '..', 'AuActivityPane.tsx');

describe('AuActivityPane', () => {
    const source = readSource(FILE);

    it.each([
        ['tabsSlice', 'the tab list is a live view; the log is a record of the past'],
        ['useSelector', 'a store read at display time IS the lookup this test forbids'],
        ['terminalService', 'the service can only answer about terminals that still exist'],
        ['resolveTerminal', 'any name-resolution helper, by whatever name'],
        ['displayLabel', "the live label, which is not the one the row was written with"],
        ['identity', 'the id index answers for live leaves only'],
    ])('does not mention `%s` — %s', (needle) => {
        expect(source).not.toContain(needle);
    });

    it('renders the stored name, and an empty column when there is none', () => {
        // The positive half. Without it every assertion above passes on a file that renders no name
        // at all — which is the same wrong answer arrived at by a different route.
        expect(source).toContain('entry.terminalName ?? \'\'');
        expect(source).toContain('entry.terminalId ?? ');
    });

    it('takes its rows as a prop rather than fetching them', () => {
        // A fetch inside this component would be a second reader of the log with its own scope and
        // its own limit, and the drawer would then disagree with the panel about what happened.
        expect(source).not.toContain('loadAutomationLog');
        expect(source).not.toContain('electronAPI');
        expect(source).toContain('entries: AutomationLogEntry[]');
    });
});
