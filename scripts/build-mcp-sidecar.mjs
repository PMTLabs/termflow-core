import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function getHostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to determine Rust host triple');
  }
  const output = result.stdout;
  const match = output.match(/^host:\s+(\S+)$/m);
  if (!match) {
    throw new Error('Failed to determine Rust host triple');
  }
  return match[1];
}

function main() {
  const rootDir = process.cwd();
  const hostTriple = getHostTriple();
  const binaryName = 'termflow-mcp-server';
  const ext = process.platform === 'win32' ? '.exe' : '';
  const outDir = join(rootDir, 'src-tauri', 'binaries');
  const outFile = join(outDir, `${binaryName}-${hostTriple}${ext}`);

  mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    'bun',
    [
      'build',
      '--compile',
      '--target=bun',
      `--outfile=${outFile}`,
      join('mcp-server', 'src', 'index.ts'),
    ],
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Built MCP sidecar: ${outFile}`);
}

main();
