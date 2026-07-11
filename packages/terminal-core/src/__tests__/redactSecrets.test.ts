import { redactSecrets } from '../redactSecrets';

describe('redactSecrets (backlog 011)', () => {
  it.each([
    ['export API_KEY=abc123secret', 'export API_KEY=***'],
    ['set PASSWORD=hunter2', 'set PASSWORD=***'],
    ['mysql -u root password=hunter2', 'mysql -u root password=***'],
    ['curl -H "Authorization: Bearer sk-live-abcdef123456"', 'curl -H "Authorization: Bearer ***"'],
    ['docker login --password s3cr3t', 'docker login --password ***'],
    ['echo token="abc def"', 'echo token=***'],
    ['aws configure set aws_secret_access_key=AKIAABCDEFGH1234', 'aws configure set aws_secret_access_key=***'],
    ['export SECRET_KEY=supersecret', 'export SECRET_KEY=***'], // keyword-as-prefix names (Django)
    ['export SECRET_KEY_BASE=abc123', 'export SECRET_KEY_BASE=***'], // Rails
    ['export PRIVATE_KEY=abc123', 'export PRIVATE_KEY=***'],
    ['export AUTH_TOKEN_PROD=abc123', 'export AUTH_TOKEN_PROD=***'], // keyword mid-name
    ['echo sk-proj-abcdefgh12345678', 'echo ***'],
    ['slack-cli --token xoxb-123456789012-abcdef', 'slack-cli --token ***'],
  ])('redacts %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('redacts a QUOTED bearer token (value wrapped in quotes)', () => {
    const out = redactSecrets('curl -H "Authorization: Bearer \\"my.secret.jwt\\""');
    expect(out).not.toContain('my.secret.jwt');
  });

  it('redacts a GitHub PAT embedded in a URL', () => {
    const out = redactSecrets('git clone https://ghp_abcdefghij1234567890@github.com/x/y');
    expect(out).not.toContain('ghp_abcdefghij1234567890');
    expect(out).toContain('github.com/x/y');
  });

  it.each([
    'git status',
    'dotnet build -c Release',
    'bun run test',
    'echo my-passport-photo.jpg', // "pass" substring must not trigger
    'cd tokens/design', // "token" as a path segment, no = or :
    'echo "my token:"', // trailing quote after ':' must not be swallowed (quote-corruption regression)
    "grep 'password:' config.md", // quoted search text, value alternative must stop at the quote
    'git commit -m "docs: explain token= syntax"', // empty assignment: next WORD must not be redacted
    'az login --password= --username u', // empty --flag=: the following flag must survive
  ])('leaves %s untouched', (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('redacts the WHOLE value when it contains shell-escaped quotes (no tail leak)', () => {
    const out = redactSecrets('curl -d password="my\\"secret"');
    expect(out).not.toContain('secret');
    expect(out).toBe('curl -d password=***');
  });

  it('keeps the rest of the command intact (redact value, never drop the line)', () => {
    expect(redactSecrets('deploy --env prod --token abc123 --verbose')).toBe(
      'deploy --env prod --token *** --verbose',
    );
  });
});
