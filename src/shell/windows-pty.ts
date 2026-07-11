import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

export interface WSLDistro {
  name: string;
  version: number;
  isDefault: boolean;
  state: 'Running' | 'Stopped';
}

export class WindowsPTY {
  /**
   * Check if ConPTY is supported on current Windows version
   * ConPTY requires Windows 10 version 1803 (build 17134) or later
   */
  static isConPTYSupported(): boolean {
    if (process.platform !== 'win32') {
      return false;
    }

    try {
      const release = os.release();
      const [major, minor, build] = release.split('.').map(Number);
      
      // Windows 10 is version 10.0
      if (major === 10 && minor === 0) {
        // ConPTY requires build 17134 or later
        return build >= 17134;
      }
      
      // Windows 11 and later support ConPTY
      return major > 10;
    } catch (error) {
      console.error('Failed to check Windows version:', error);
      return false;
    }
  }

  /**
   * Get the default shell for Windows
   */
  static getDefaultShell(): string {
    // Check environment variables
    if (process.env.COMSPEC) {
      return process.env.COMSPEC;
    }

    // Default to cmd.exe
    return 'cmd.exe';
  }

  /**
   * Resolve shell path for Windows shells
   */
  static resolveShellPath(shell: string): string {
    // If already an absolute path, return as-is
    if (path.isAbsolute(shell)) {
      return shell;
    }

    // Common shell mappings
    const shellMappings: Record<string, string[]> = {
      'cmd': ['cmd.exe'],
      'cmd.exe': ['cmd.exe'],
      'powershell': ['powershell.exe'],
      'powershell.exe': ['powershell.exe'],
      'pwsh': ['pwsh.exe', 'pwsh'],
      'pwsh.exe': ['pwsh.exe', 'pwsh'],
      'bash': [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'bash.exe',
      ],
      'bash.exe': [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'bash.exe',
      ],
      'wsl': ['wsl.exe'],
      'wsl.exe': ['wsl.exe'],
    };

    const shellLower = shell.toLowerCase();
    const candidates = shellMappings[shellLower] || [shell];

    // Try to find the shell
    for (const candidate of candidates) {
      try {
        // Check if it's in PATH
        const result = execSync(`where ${candidate}`, { 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
        
        const paths = result.split('\n').filter(p => p.trim());
        if (paths.length > 0) {
          return paths[0].trim();
        }
      } catch {
        // Not in PATH, check absolute path
        if (path.isAbsolute(candidate)) {
          const fs = require('fs');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    }

    // Return original if not found
    return shell;
  }

  /**
   * Get available WSL distributions
   */
  static getWSLDistributions(): WSLDistro[] {
    const distros: WSLDistro[] = [];

    try {
      // Check if WSL is available
      execSync('wsl.exe --help', { stdio: 'ignore' });
    } catch {
      // WSL not available
      return distros;
    }

    try {
      // Get list of distributions
      const output = execSync('wsl.exe -l -v', { encoding: 'utf8' });
      const lines = output.split('\n').slice(1); // Skip header

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse WSL output
        // Format: NAME STATE VERSION
        const match = trimmed.match(/^\*?\s*(\S+)\s+(Running|Stopped)\s+(\d+)/);
        if (match) {
          const [, name, state, version] = match;
          const isDefault = line.startsWith('*');
          
          distros.push({
            name: name,
            version: parseInt(version, 10),
            isDefault,
            state: state as 'Running' | 'Stopped',
          });
        }
      }
    } catch (error) {
      console.error('Failed to get WSL distributions:', error);
    }

    return distros;
  }

  /**
   * Get PowerShell execution policy
   */
  static getPowerShellExecutionPolicy(): string {
    try {
      const output = execSync('powershell.exe -Command "Get-ExecutionPolicy"', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return output.trim();
    } catch {
      return 'Unknown';
    }
  }

  /**
   * Create PowerShell arguments based on execution policy
   */
  static getPowerShellArgs(skipProfile: boolean = false): string[] {
    const args = ['-NoLogo'];
    
    // Check execution policy
    const policy = this.getPowerShellExecutionPolicy();
    if (policy === 'Restricted') {
      // Bypass execution policy for interactive session
      args.push('-ExecutionPolicy', 'Bypass');
    }

    if (skipProfile) {
      args.push('-NoProfile');
    }

    return args;
  }

  /**
   * Get environment variables for Windows shells
   */
  static getShellEnvironment(shell: string): Record<string, string> {
    const env: Record<string, string> = {};

    // Git Bash specific
    if (shell.toLowerCase().includes('bash')) {
      env.TERM = 'xterm-256color';
      env.CHERE_INVOKING = '1'; // Start in current directory
      
      // Add Git to PATH if not already there
      const gitPath = 'C:\\Program Files\\Git\\usr\\bin';
      if (process.env.PATH && !process.env.PATH.includes(gitPath)) {
        env.PATH = `${gitPath};${process.env.PATH}`;
      }
    }

    // PowerShell Core specific
    if (shell.toLowerCase().includes('pwsh')) {
      env.NO_COLOR = '1'; // Disable ANSI colors if terminal doesn't support
    }

    return env;
  }

  /**
   * Handle special encoding for Windows shells
   */
  static getShellEncoding(shell: string): string {
    const shellLower = shell.toLowerCase();

    // CMD uses different encoding based on locale
    if (shellLower.includes('cmd')) {
      try {
        const output = execSync('chcp', { encoding: 'utf8' });
        const match = output.match(/:\s*(\d+)/);
        if (match) {
          const codepage = match[1];
          // Map common codepages
          switch (codepage) {
            case '65001': return 'utf8';
            case '437': return 'cp437';
            case '850': return 'cp850';
            default: return 'utf8';
          }
        }
      } catch {}
    }

    return 'utf8';
  }

  /**
   * Create startup script for shell initialization
   */
  static getStartupScript(shell: string): string | undefined {
    const shellLower = shell.toLowerCase();

    // Git Bash - ensure proper terminal setup
    if (shellLower.includes('bash')) {
      return 'export TERM=xterm-256color; clear';
    }

    // PowerShell - set up prompt
    if (shellLower.includes('powershell') || shellLower.includes('pwsh')) {
      return 'Clear-Host';
    }

    return undefined;
  }

  /**
   * Detect if running in Windows Terminal
   */
  static isWindowsTerminal(): boolean {
    return process.env.WT_SESSION !== undefined;
  }

  /**
   * Get terminal emulator info
   */
  static getTerminalInfo(): { name: string; version?: string } {
    if (this.isWindowsTerminal()) {
      return { 
        name: 'Windows Terminal',
        version: process.env.WT_SESSION,
      };
    }

    // Check for other terminals
    if (process.env.TERM_PROGRAM) {
      return {
        name: process.env.TERM_PROGRAM,
        version: process.env.TERM_PROGRAM_VERSION,
      };
    }

    return { name: 'Unknown' };
  }

  /**
   * Check if Unicode is properly supported
   */
  static isUnicodeSupported(): boolean {
    if (this.isWindowsTerminal()) {
      return true;
    }

    // Check Windows version for Unicode support
    if (this.isConPTYSupported()) {
      return true;
    }

    // Legacy console may have issues
    return false;
  }

  /**
   * Get recommended PTY options for Windows
   */
  static getRecommendedPtyOptions(): any {
    const options: any = {
      name: 'xterm-256color',
      useConpty: this.isConPTYSupported(),
    };

    // Use ConPTY if available
    if (options.useConpty) {
      options.experimentalUseConptyDll = true;
    }

    return options;
  }
}