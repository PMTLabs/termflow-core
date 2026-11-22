import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';

export default async function setup() {
  // Playwright's runner can be Node even when the package script was started by Bun.
  const server = spawn('bun', [path.join(__dirname, 'server.ts')], {
    cwd: path.resolve(__dirname, '../../..'), stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(server, 'exit');
  const lines = createInterface({ input: server.stdout });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    if (server.exitCode !== null) return;
    server.stdin.end();
    await exited;
  };
  try {
    process.env.SSH_CANVAS_URL = await Promise.race([
      once(lines, 'line').then(([line]) => {
        if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)) throw new Error(`Unexpected fixture URL: ${line}`);
        return line as string;
      }),
      exited.then(([code]) => { throw new Error(`Fixture server exited before readiness (${code})`); }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Fixture server startup timed out')), 30_000);
      }),
    ]);
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    lines.close();
  }
  return stop;
}
