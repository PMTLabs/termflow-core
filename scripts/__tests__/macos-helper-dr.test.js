const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const script = resolve(root, 'scripts/macos-helper-dr.sh');
const id = 'app.termflow.desktop.pty-host';
const team = '68M75D67LJ';
// `codesign -d -r-` output for a Developer ID Application signature (stdout carries the DR line).
const approved = `designated => identifier "${id}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${team}"`;
const executable = `Executable=/x/TermFlow Host.app/Contents/MacOS/termflow-pty-host`;

const check = input => spawnSync('bash', [script, id, team], { input, encoding: 'utf8' }).status;
const unix = process.platform === 'win32' ? describe.skip : describe;

unix('macos-helper-dr.sh', () => {
  test('accepts exactly the update-stable Developer ID requirement', () => {
    expect(check(`${executable}\n${approved}\n`)).toBe(0);
  });

  test.each([
    ['a cdhash clause (the round-1 counterexample)', `${approved} and cdhash H"0123456789abcdef0123456789abcdef01234567"`],
    ['a path clause', `${approved} and info [CFBundlePath] = "/Applications"`],
    ['another team', approved.replace(team, 'AAAAAAAAAA')],
    ['another identifier', approved.replace(id, `${id}.spike`)],
    ['an ad-hoc cdhash-only requirement', 'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"'],
    ['no designated line', executable],
    ['two designated lines', `${approved}\n${approved}`],
  ])('rejects %s', (_, input) => {
    expect(check(`${input}\n`)).not.toBe(0);
  });

  test('publish-macos.sh verifies the helper through this script, not substring greps', () => {
    const publish = readFileSync(resolve(root, 'publish-macos.sh'), 'utf8');
    expect(publish).toContain('"$SCRIPT_DIR/scripts/macos-helper-dr.sh" "$HOST_ID" "$SIGN_TEAM" <<< "$requirement"');
    expect(publish).not.toMatch(/grep[^\n]*identifier \\"\$HOST_ID\\"/);
  });
});
