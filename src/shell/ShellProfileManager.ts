import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { WindowsPTY } from './windows-pty';

export interface ShellProfile {
  id: string;
  name: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  icon?: string;
  isDefault?: boolean;
  isCustom?: boolean;
}

export interface ShellProfileManagerOptions {
  configPath?: string;
  autoDetect?: boolean;
}

export class ShellProfileManager extends EventEmitter {
  private profiles: Map<string, ShellProfile>;
  private configPath: string;
  private defaultProfileId: string | null = null;

  constructor(options: ShellProfileManagerOptions = {}) {
    super();
    
    this.profiles = new Map();
    this.configPath = options.configPath || 
      path.join(os.homedir(), '.auto-terminal', 'profiles.json');
    
    // Initialize with default profiles
    this.initializeDefaultProfiles();
    
    // Load custom profiles
    this.loadCustomProfiles();
    
    // Auto-detect if enabled
    if (options.autoDetect !== false) {
      this.autoDetectShells();
    }
  }

  /**
   * Initialize built-in default profiles
   */
  private initializeDefaultProfiles(): void {
    if (process.platform === 'win32') {
      // Windows default profiles
      this.addProfile({
        id: 'cmd',
        name: 'Command Prompt',
        executable: WindowsPTY.resolveShellPath('cmd.exe'),
        args: [],
        env: WindowsPTY.getShellEnvironment('cmd.exe'),
        icon: 'terminal-cmd',
      });

      this.addProfile({
        id: 'powershell',
        name: 'PowerShell',
        executable: WindowsPTY.resolveShellPath('powershell.exe'),
        args: WindowsPTY.getPowerShellArgs(),
        env: WindowsPTY.getShellEnvironment('powershell.exe'),
        icon: 'terminal-powershell',
      });

      this.addProfile({
        id: 'pwsh',
        name: 'PowerShell Core',
        executable: WindowsPTY.resolveShellPath('pwsh.exe'),
        args: WindowsPTY.getPowerShellArgs(),
        env: WindowsPTY.getShellEnvironment('pwsh.exe'),
        icon: 'terminal-powershell',
      });
    } else {
      // Unix-like default profiles
      this.addProfile({
        id: 'bash',
        name: 'Bash',
        executable: '/bin/bash',
        args: ['--login'],
        env: {},
        icon: 'terminal-bash',
      });

      this.addProfile({
        id: 'zsh',
        name: 'Zsh',
        executable: '/bin/zsh',
        args: ['--login'],
        env: {},
        icon: 'terminal-zsh',
      });

      this.addProfile({
        id: 'sh',
        name: 'Shell',
        executable: '/bin/sh',
        args: [],
        env: {},
        icon: 'terminal',
      });
    }
  }

  /**
   * Auto-detect installed shells
   */
  private autoDetectShells(): void {
    if (process.platform === 'win32') {
      this.detectWindowsShells();
    } else {
      this.detectUnixShells();
    }
  }

  /**
   * Detect Windows shells
   */
  private detectWindowsShells(): void {
    // Check for Git Bash
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      path.join(process.env.PROGRAMFILES || '', 'Git', 'bin', 'bash.exe'),
    ];

    for (const gitPath of gitBashPaths) {
      if (this.fileExists(gitPath)) {
        this.addProfile({
          id: 'git-bash',
          name: 'Git Bash',
          executable: gitPath,
          args: ['--login', '-i'],
          env: { TERM: 'xterm-256color' },
          icon: 'terminal-bash',
        });
        break;
      }
    }

    // Check for WSL
    if (this.commandExists('wsl.exe')) {
      this.addProfile({
        id: 'wsl',
        name: 'WSL',
        executable: 'wsl.exe',
        args: [],
        env: {},
        icon: 'terminal-linux',
      });

      // Try to detect specific WSL distributions
      this.detectWSLDistributions();
    }

    // Check for Cygwin
    const cygwinPath = 'C:\\cygwin64\\bin\\bash.exe';
    if (this.fileExists(cygwinPath)) {
      this.addProfile({
        id: 'cygwin',
        name: 'Cygwin Bash',
        executable: cygwinPath,
        args: ['--login', '-i'],
        env: {},
        icon: 'terminal-bash',
      });
    }
  }

  /**
   * Detect Unix shells
   */
  private detectUnixShells(): void {
    const shellsToCheck = [
      { path: '/usr/bin/fish', name: 'Fish', id: 'fish', icon: 'terminal-fish' },
      { path: '/usr/local/bin/fish', name: 'Fish', id: 'fish-local', icon: 'terminal-fish' },
      { path: '/opt/local/bin/bash', name: 'MacPorts Bash', id: 'macports-bash', icon: 'terminal-bash' },
      { path: '/usr/local/bin/bash', name: 'Homebrew Bash', id: 'brew-bash', icon: 'terminal-bash' },
      { path: '/usr/local/bin/zsh', name: 'Homebrew Zsh', id: 'brew-zsh', icon: 'terminal-zsh' },
    ];

    for (const shell of shellsToCheck) {
      if (this.fileExists(shell.path)) {
        this.addProfile({
          id: shell.id,
          name: shell.name,
          executable: shell.path,
          args: ['--login'],
          env: {},
          icon: shell.icon,
        });
      }
    }
  }

  /**
   * Detect WSL distributions
   */
  private detectWSLDistributions(): void {
    try {
      const distros = WindowsPTY.getWSLDistributions();
      
      for (const distro of distros) {
        this.addProfile({
          id: `wsl-${distro.name.toLowerCase()}`,
          name: `WSL - ${distro.name} (v${distro.version})`,
          executable: 'wsl.exe',
          args: ['-d', distro.name],
          env: {},
          icon: 'terminal-linux',
          isDefault: distro.isDefault,
        });
      }
    } catch (error) {
      console.error('Failed to detect WSL distributions:', error);
    }
  }

  /**
   * Load custom profiles from config file
   */
  private loadCustomProfiles(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(data);
        
        if (config.profiles && Array.isArray(config.profiles)) {
          for (const profile of config.profiles) {
            this.addProfile({ ...profile, isCustom: true });
          }
        }
        
        if (config.defaultProfileId) {
          this.defaultProfileId = config.defaultProfileId;
        }
      }
    } catch (error) {
      console.error('Failed to load custom profiles:', error);
    }
  }

  /**
   * Save custom profiles to config file
   */
  private saveCustomProfiles(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const customProfiles = Array.from(this.profiles.values())
        .filter(profile => profile.isCustom);

      const config = {
        profiles: customProfiles,
        defaultProfileId: this.defaultProfileId,
      };

      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      this.emit('profiles-saved');
    } catch (error) {
      console.error('Failed to save custom profiles:', error);
      this.emit('save-error', error);
    }
  }

  /**
   * Add a profile
   */
  addProfile(profile: ShellProfile): void {
    // Validate profile
    if (!this.validateProfile(profile)) {
      throw new Error('Invalid profile configuration');
    }

    this.profiles.set(profile.id, profile);
    
    // Set as default if it's the first profile
    if (!this.defaultProfileId) {
      this.defaultProfileId = profile.id;
      profile.isDefault = true;
    }

    this.emit('profile-added', profile);
  }

  /**
   * Remove a profile
   */
  removeProfile(profileId: string): void {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    if (profile.isCustom) {
      this.profiles.delete(profileId);
      
      // Update default if needed
      if (this.defaultProfileId === profileId) {
        const firstProfile = this.profiles.values().next().value;
        this.defaultProfileId = firstProfile ? firstProfile.id : null;
      }

      this.saveCustomProfiles();
      this.emit('profile-removed', profileId);
    } else {
      throw new Error('Cannot remove built-in profile');
    }
  }

  /**
   * Update a profile
   */
  updateProfile(profileId: string, updates: Partial<ShellProfile>): void {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    if (!profile.isCustom) {
      throw new Error('Cannot update built-in profile');
    }

    const updatedProfile = { ...profile, ...updates, id: profileId };
    
    if (!this.validateProfile(updatedProfile)) {
      throw new Error('Invalid profile configuration');
    }

    this.profiles.set(profileId, updatedProfile);
    this.saveCustomProfiles();
    this.emit('profile-updated', updatedProfile);
  }

  /**
   * Get a profile by ID
   */
  getProfile(profileId: string): ShellProfile | undefined {
    return this.profiles.get(profileId);
  }

  /**
   * Get all profiles
   */
  getAllProfiles(): ShellProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get default profile
   */
  getDefaultProfile(): ShellProfile | undefined {
    if (this.defaultProfileId) {
      return this.profiles.get(this.defaultProfileId);
    }
    return this.profiles.values().next().value;
  }

  /**
   * Set default profile
   */
  setDefaultProfile(profileId: string): void {
    if (!this.profiles.has(profileId)) {
      throw new Error(`Profile ${profileId} not found`);
    }

    // Clear previous default
    if (this.defaultProfileId) {
      const prevDefault = this.profiles.get(this.defaultProfileId);
      if (prevDefault) {
        prevDefault.isDefault = false;
      }
    }

    // Set new default
    this.defaultProfileId = profileId;
    const profile = this.profiles.get(profileId);
    if (profile) {
      profile.isDefault = true;
    }

    this.saveCustomProfiles();
    this.emit('default-changed', profileId);
  }

  /**
   * Validate profile configuration
   */
  private validateProfile(profile: ShellProfile): boolean {
    if (!profile.id || !profile.name || !profile.executable) {
      return false;
    }

    // Check if executable exists or is a command
    if (!this.fileExists(profile.executable) && !this.commandExists(profile.executable)) {
      console.warn(`Shell executable not found: ${profile.executable}`);
      // Don't fail validation, as the shell might be in PATH
    }

    return true;
  }

  /**
   * Check if a file exists
   */
  private fileExists(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Check if a command exists in PATH
   */
  private commandExists(command: string): boolean {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        execSync(`where ${command}`, { stdio: 'ignore' });
      } else {
        execSync(`which ${command}`, { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a custom profile
   */
  createCustomProfile(config: Omit<ShellProfile, 'id' | 'isCustom'>): string {
    const profileId = `custom-${Date.now()}`;
    const profile: ShellProfile = {
      ...config,
      id: profileId,
      isCustom: true,
    };

    this.addProfile(profile);
    this.saveCustomProfiles();
    
    return profileId;
  }

  /**
   * Export profiles
   */
  exportProfiles(): string {
    const profiles = Array.from(this.profiles.values());
    return JSON.stringify({ profiles, defaultProfileId: this.defaultProfileId }, null, 2);
  }

  /**
   * Import profiles
   */
  importProfiles(data: string): void {
    try {
      const config = JSON.parse(data);
      
      if (config.profiles && Array.isArray(config.profiles)) {
        for (const profile of config.profiles) {
          if (profile.isCustom) {
            this.addProfile(profile);
          }
        }
        
        this.saveCustomProfiles();
        this.emit('profiles-imported', config.profiles.length);
      }
    } catch (error) {
      throw new Error('Failed to import profiles: Invalid format');
    }
  }
}