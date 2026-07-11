import { spawn as spawnProcess, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';

export interface IPtyFallback {
  pid: number;
  process: string;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (exitCode: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
}

export class WindowsFallbackPty extends EventEmitter implements IPtyFallback {
  private childProcess: ChildProcessWithoutNullStreams;
  public pid: number;
  public process: string;

  constructor(
    file: string,
    args: string[] = [],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {
    super();
    
    // Spawn the process directly using child_process
    this.childProcess = spawnProcess(file, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']  // Ensure pipes are created
    });

    this.pid = this.childProcess.pid || 0;
    this.process = file;
    
    console.log(`WindowsFallbackPty: Created process with PID ${this.pid}`);

    // Ensure stdout/stderr are in flowing mode
    if (this.childProcess.stdout) {
      this.childProcess.stdout.setEncoding('utf8');
      this.childProcess.stdout.on('data', (data) => {
        console.log('WindowsFallbackPty: stdout data:', data.substring(0, 50) + '...');
        this.emit('data', data);
      });
    } else {
      console.error('WindowsFallbackPty: No stdout stream!');
    }

    if (this.childProcess.stderr) {
      this.childProcess.stderr.setEncoding('utf8');
      this.childProcess.stderr.on('data', (data) => {
        console.log('WindowsFallbackPty: stderr data:', data.substring(0, 50) + '...');
        this.emit('data', data);
      });
    } else {
      console.error('WindowsFallbackPty: No stderr stream!');
    }

    // Handle exit
    this.childProcess.on('exit', (code, signal) => {
      this.emit('exit', { exitCode: code || 0, signal });
    });

    // Handle errors
    this.childProcess.on('error', (err) => {
      console.error('Process error:', err);
      this.emit('exit', { exitCode: 1 });
    });
    
    // For Windows shells, send an initial prompt command
    setTimeout(() => {
      console.log('WindowsFallbackPty: Sending initial prompt trigger');
      // Send empty command to trigger prompt display
      this.childProcess.stdin.write('\r\n');
    }, 100);
  }

  onData(callback: (data: string) => void): void {
    this.on('data', callback);
  }

  onExit(callback: (exitCode: { exitCode: number; signal?: number }) => void): void {
    this.on('exit', callback);
  }

  write(data: string): void {
    if (this.childProcess && this.childProcess.stdin && this.childProcess.stdin.writable) {
      console.log('WindowsFallbackPty: Writing data:', data);
      this.childProcess.stdin.write(data);
    } else {
      console.warn('WindowsFallbackPty: Cannot write - stdin not writable');
    }
  }

  resize(_cols: number, _rows: number): void {
    // Not supported in fallback mode
    console.warn('Resize not supported in fallback PTY mode');
  }

  kill(signal?: string): void {
    if (this.childProcess) {
      this.childProcess.kill(signal as any);
    }
  }
}

export function spawn(
  file: string,
  args: string[] = [],
  options: any = {}
): IPtyFallback {
  return new WindowsFallbackPty(file, args, options);
}