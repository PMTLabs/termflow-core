// PTY Wrapper - abstracts the underlying PTY implementation
// Using prebuilt node-pty to avoid native compilation issues

import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import * as fallbackPty from './windows-fallback-pty';

export interface IPtyProcessOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  encoding?: string;
}

export interface IPtyProcess {
  pid: number;
  process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData: IEvent<string>;
  onExit: IEvent<{ exitCode: number; signal?: number }>;
}

export interface IEvent<T> {
  (listener: (e: T) => void): IDisposable;
}

export interface IDisposable {
  dispose(): void;
}

export class PtyProcess extends EventEmitter implements IPtyProcess {
  private _ptyProcess: pty.IPty | fallbackPty.IPtyFallback;
  private _pid: number;
  private _process: string;

  constructor(
    shell: string,
    args: string[],
    options: IPtyProcessOptions
  ) {
    super();

    // Spawn the PTY process
    const ptyOptions: any = {
      name: options.name || 'xterm-color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env } as { [key: string]: string }
    };

    // Windows-specific options
    if (process.platform === 'win32') {
      // IMPORTANT: Disable ConPTY and use legacy winpty mode
      // ConPTY has known output buffering issues that cause 30-80+ second delays
      // See: https://github.com/microsoft/node-pty/issues/437
      ptyOptions.useConpty = false;

      // Legacy winpty options for better real-time output
      ptyOptions.windowsVerbatimArguments = false;

      // Do NOT set encoding on Windows - it's handled differently
      delete ptyOptions.encoding;
    } else {
      // Unix-like systems support encoding
      ptyOptions.encoding = options.encoding || 'utf8';
    }

    try {
      console.log('PtyProcess: Attempting to spawn with native node-pty...');
      this._ptyProcess = pty.spawn(shell, args, ptyOptions);
      console.log('PtyProcess: Successfully spawned with native node-pty');
    } catch (error) {
      console.error(`Failed to spawn PTY process with shell ${shell}:`, error);
      // Try fallback on Windows if native module fails
      if (process.platform === 'win32' && (error as Error).message?.includes('Cannot find module')) {
        console.warn('Native PTY module not found, using Windows fallback');
        this._ptyProcess = fallbackPty.spawn(shell, args, ptyOptions);
        console.log('PtyProcess: Successfully spawned with Windows fallback');
      } else {
        throw error;
      }
    }

    this._pid = this._ptyProcess.pid;
    this._process = shell;

    // Forward events
    this._ptyProcess.onData((data: string) => {
      this.emit('data', data);
    });

    this._ptyProcess.onExit((exitInfo: any) => {
      // Handle both signatures (native pty and fallback)
      if (typeof exitInfo === 'object' && 'exitCode' in exitInfo) {
        this.emit('exit', { exitCode: exitInfo.exitCode, signal: exitInfo.signal });
      } else {
        this.emit('exit', { exitCode: exitInfo, signal: undefined });
      }
    });
  }

  get pid(): number {
    return this._pid;
  }

  get process(): string {
    return this._process;
  }

  write(data: string): void {
    this._ptyProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    this._ptyProcess.resize(cols, rows);
  }

  kill(signal?: string): void {
    try {
      if (this._ptyProcess) {
        // On Windows, don't pass signals as they're not supported
        if (process.platform === 'win32') {
          this._ptyProcess.kill(); // No signal parameter for Windows
        } else {
          this._ptyProcess.kill(signal);
        }
      }
    } catch (error) {
      // Handle Windows-specific errors more gracefully
      const errorMessage = (error as Error).message;
      if (process.platform === 'win32' && (
        errorMessage?.includes('AttachConsole') ||
        errorMessage?.includes('Signals not supported')
      )) {
        console.warn('Windows PTY cleanup warning (safe to ignore):', errorMessage);
      } else {
        console.error('Error killing PTY process:', error);
        throw error;
      }
    }
  }

  get onData(): IEvent<string> {
    return (listener: (data: string) => void): IDisposable => {
      this.on('data', listener);
      return {
        dispose: () => this.removeListener('data', listener)
      };
    };
  }

  get onExit(): IEvent<{ exitCode: number; signal?: number }> {
    return (listener: (e: { exitCode: number; signal?: number }) => void): IDisposable => {
      this.on('exit', listener);
      return {
        dispose: () => this.removeListener('exit', listener)
      };
    };
  }
}

// Platform-specific shell detection
export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    // COMSPEC should already be a full path, fallback to System32
    return process.env.COMSPEC || `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`;
  }
  return process.env.SHELL || '/bin/bash';
}

export function getAvailableShells(): Array<{ name: string; path: string }> {
  const shells: Array<{ name: string; path: string }> = [];

  if (process.platform === 'win32') {
    // Windows shells - use full paths
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    shells.push({ name: 'Command Prompt', path: `${systemRoot}\\System32\\cmd.exe` });
    shells.push({ name: 'PowerShell', path: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` });

    shells.push({ name: 'Claude', path: `${process.env.APPDATA}\\npm\\claude.cmd` });

    // Check for Git Bash
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];

    for (const path of gitBashPaths) {
      try {
        if (require('fs').existsSync(path)) {
          shells.push({ name: 'Git Bash', path });
          break;
        }
      } catch { }
    }
  } else {
    // Unix-like shells
    const unixShells = [
      { name: 'Bash', path: '/bin/bash' },
      { name: 'Zsh', path: '/bin/zsh' },
      { name: 'Fish', path: '/usr/bin/fish' },
    ];

    for (const shell of unixShells) {
      try {
        if (require('fs').existsSync(shell.path)) {
          shells.push(shell);
        }
      } catch { }
    }
  }

  return shells;
}