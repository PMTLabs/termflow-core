// Mock PTY implementation for development
// TODO: Replace with real node-pty when build issues are resolved

import { EventEmitter } from 'events';

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string };
  encoding?: string;
}

export interface IPtyProcess extends EventEmitter {
  pid: number;
  cols: number;
  rows: number;
  process: string;
  
  write(data: string): void;
  resize(cols: number, rows: number): void;
  destroy(): void;
  kill(signal?: string): void;
}

class MockPtyProcess extends EventEmitter implements IPtyProcess {
  public pid: number;
  public cols: number;
  public rows: number;
  public process: string;
  private _isAlive: boolean = true;
  private _mockShell: string;

  constructor(file: string, _args: string[], options: IPtyForkOptions) {
    super();
    this.pid = Math.floor(Math.random() * 10000);
    this.cols = options.cols || 80;
    this.rows = options.rows || 24;
    this.process = file;
    this._mockShell = file.toLowerCase();

    // Simulate shell startup
    setTimeout(() => {
      if (this._isAlive) {
        this.emit('data', this._getWelcomeMessage());
        this.emit('data', this._getPrompt());
      }
    }, 100);
  }

  private _getWelcomeMessage(): string {
    if (this._mockShell.includes('powershell')) {
      return 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\n';
    } else if (this._mockShell.includes('cmd')) {
      return 'Microsoft Windows [Version 10.0.19043.1234]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n';
    } else if (this._mockShell.includes('bash')) {
      return 'GNU bash, version 5.0.17(1)-release (x86_64-pc-linux-gnu)\r\n';
    }
    return 'Mock Terminal v1.0\r\n';
  }

  private _getPrompt(): string {
    if (this._mockShell.includes('powershell')) {
      return 'PS C:\\> ';
    } else if (this._mockShell.includes('cmd')) {
      return 'C:\\>';
    } else if (this._mockShell.includes('bash')) {
      return '$ ';
    }
    return '> ';
  }

  write(data: string): void {
    if (!this._isAlive) return;

    // Echo the input
    this.emit('data', data);

    // Handle special commands
    if (data.includes('\r') || data.includes('\n')) {
      const command = data.trim();
      
      if (command === 'exit') {
        this.kill();
        return;
      }

      // Simulate command execution
      setTimeout(() => {
        if (this._isAlive) {
          this._handleCommand(command);
          this.emit('data', '\r\n' + this._getPrompt());
        }
      }, 50);
    }
  }

  private _handleCommand(command: string): void {
    if (!command) return;

    // Mock some basic commands
    if (command === 'ls' || command === 'dir') {
      this.emit('data', '\r\nfile1.txt\r\nfile2.txt\r\nfolder1\r\nfolder2');
    } else if (command === 'pwd') {
      this.emit('data', '\r\n/home/user');
    } else if (command === 'echo $PATH' || command === 'echo %PATH%') {
      this.emit('data', '\r\n/usr/local/bin:/usr/bin:/bin');
    } else if (command.startsWith('echo ')) {
      const text = command.substring(5);
      this.emit('data', '\r\n' + text);
    } else {
      this.emit('data', `\r\nMock output for: ${command}`);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    // In real implementation, this would resize the PTY
  }

  destroy(): void {
    this.kill();
  }

  kill(_signal?: string): void {
    if (!this._isAlive) return;
    
    this._isAlive = false;
    this.emit('exit', 0);
    this.removeAllListeners();
  }
}

export function spawn(
  file: string,
  args?: string[],
  options?: IPtyForkOptions
): IPtyProcess {
  return new MockPtyProcess(file, args || [], options || {});
}

export default {
  spawn
};