import { ElectronAPI, TerminalSnapshot, PeerInfo, PeerRequestInfo, PairingCode, FabricStatus, GrantLevel } from '../types/electron';

// Configuration for connecting to the Rust backend. Default matches this build's
// instance (dev backend = 42051, prod = 42031).
const API_PORT = process.env.NODE_ENV === 'development' ? 42051 : 42031;
const API_BASE_URL = `http://localhost:${API_PORT}/api`;
const WS_URL = `ws://localhost:${API_PORT}/api/ws`;

console.log('Initializing Browser Bridge...');

class BrowserBridge implements ElectronAPI {
    private ws: WebSocket | null = null;
    private dataListeners: ((id: string, data: string) => void)[] = [];
    private exitListeners: ((id: string, code: number) => void)[] = [];
    private connectionRetries = 0;
    private maxRetries = 5;

    constructor() {
        this.connectWebSocket();
    }

    private connectWebSocket() {
        console.log(`BrowserBridge: Connecting to WebSocket at ${WS_URL}`);
        try {
            this.ws = new WebSocket(WS_URL);

            this.ws.onopen = () => {
                console.log('BrowserBridge: WebSocket connected');
                this.connectionRetries = 0;
            };

            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);

                    // Handle standard pty output format from backend
                    if (message.type === 'event' && message.event.type === 'output.data') {
                        const { terminalId, data } = message.event;
                        const content = data.content;
                        this.notifyDataListeners(terminalId, content);
                    }
                    // Handle direct format if changed in future
                    else if (message.id && message.data) {
                        // this.notifyDataListeners(message.id, message.data);
                    }
                } catch (e) {
                    console.error('BrowserBridge: Failed to parse WebSocket message', e);
                }
            };

            this.ws.onclose = () => {
                console.log('BrowserBridge: WebSocket closed');
                this.ws = null;

                // Reconnect logic
                if (this.connectionRetries < this.maxRetries) {
                    this.connectionRetries++;
                    const timeout = Math.min(1000 * Math.pow(2, this.connectionRetries), 10000);
                    console.log(`BrowserBridge: Reconnecting in ${timeout}ms (attempt ${this.connectionRetries})`);
                    setTimeout(() => this.connectWebSocket(), timeout);
                }
            };

            this.ws.onerror = (error) => {
                console.error('BrowserBridge: WebSocket error', error);
            };
        } catch (e) {
            console.error('BrowserBridge: Failed to create WebSocket connection', e);
        }
    }

    private notifyDataListeners(id: string, data: string) {
        this.dataListeners.forEach(listener => listener(id, data));
    }

    private buildAuthHeaders(): Record<string, string> {
        const token = localStorage.getItem('api_token');
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    // --- Terminal Management ---

    async getTerminalOutput(terminalId: string, lines: number = 1000, offset: number = 0): Promise<{ totalLines: number; offset: number; raw: string }> {
        try {
            const response = await fetch(`${API_BASE_URL}/terminals/${terminalId}/output?lines=${lines}&offset=${offset}`, {
                headers: {
                    ...this.buildAuthHeaders(),
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch terminal output: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (e) {
            console.error('BrowserBridge: getTerminalOutput failed', e);
            throw e;
        }
    }

    async getTerminalSnapshot(terminalId: string, cols?: number, rows?: number): Promise<TerminalSnapshot> {
        try {
            const params = new URLSearchParams();
            if (cols && cols > 0) params.set('cols', String(cols));
            if (rows && rows > 0) params.set('rows', String(rows));
            const query = params.toString();
            const response = await fetch(`${API_BASE_URL}/terminals/${terminalId}/snapshot${query ? `?${query}` : ''}`, {
                headers: {
                    ...this.buildAuthHeaders(),
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch terminal snapshot: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (e) {
            console.error('BrowserBridge: getTerminalSnapshot failed', e);
            throw e;
        }
    }

    async getTerminalSize(terminalId: string): Promise<{ cols: number; rows: number }> {
        const response = await fetch(`${API_BASE_URL}/terminals/${terminalId}/size`, {
            headers: { ...this.buildAuthHeaders() },
        });
        if (!response.ok) throw new Error(`Failed to fetch terminal size: ${response.status}`);
        return await response.json();
    }

    async createTerminal(profile?: string, name?: string, cwd?: string): Promise<string> {
        try {
            const response = await fetch(`${API_BASE_URL}/terminals`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profile_id: profile,
                    name,
                    cwd,
                    cols: 80,
                    rows: 24
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to create terminal: ${response.statusText}`);
            }

            const data = await response.json();
            return data.id;
        } catch (e) {
            console.error('BrowserBridge: createTerminal failed', e);
            throw e;
        }
    }

    async closeTerminal(id: string): Promise<void> {
        try {
            await fetch(`${API_BASE_URL}/terminals/${id}`, {
                method: 'DELETE'
            });
        } catch (e) {
            console.error('BrowserBridge: closeTerminal failed', e);
        }
    }

    async pruneTerminalHistory(_keepIds: string[]): Promise<void> { /* no persistence in the browser bridge */ }

    async writeToTerminal(id: string, data: string): Promise<void> {
        try {
            await fetch(`${API_BASE_URL}/terminals/${id}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data })
            });
        } catch (e) {
            console.error('BrowserBridge: writeToTerminal failed', e);
        }
    }

    async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
        try {
            await fetch(`${API_BASE_URL}/terminals/${id}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows })
            });
        } catch (e) {
            console.error('BrowserBridge: resizeTerminal failed', e);
        }
    }

    async updateTerminalName(_id: string, _name: string): Promise<boolean> {
        // Not strictly implemented in backend REST API yet, but we can mock success
        return true;
    }

    // --- Backlog 003/004: no-op parity stubs (these features are Tauri-only;
    // the web monitor has no native cwd query or OS open) ---

    async getTerminalCwd(_processId: string): Promise<string | null> {
        return null;
    }

    async resolveTerminalPath(_processId: string, _rel: string): Promise<string[]> {
        return [];
    }

    async openExternal(_url: string): Promise<void> {
        // No native opener in the browser host.
    }

    async openPath(_path: string): Promise<void> {
        // No native opener in the browser host.
    }

    async openInEditor(_editor: string, _path: string, _line?: number, _col?: number): Promise<void> {
        // No native opener in the browser host.
    }

    async pickExecutablePath(): Promise<string | null> {
        // No native file picker in the browser host.
        return null;
    }

    // --- PTY Communication Aliases ---

    async sendToPty(processId: string, data: string): Promise<void> {
        return this.writeToTerminal(processId, data);
    }

    resizePty(processId: string, cols: number, rows: number): void {
        this.resizeTerminal(processId, cols, rows);
    }

    // --- Event Listeners ---

    onTerminalData(callback: (id: string, data: string) => void): void {
        this.dataListeners.push(callback);
    }

    onTerminalExit(callback: (id: string, code: number) => void): void {
        this.exitListeners.push(callback);
    }

    // --- System Info & Config (Mocked or API backed) ---

    async getShellProfiles(): Promise<any[]> {
        try {
            const response = await fetch(`${API_BASE_URL}/profiles`);
            if (response.ok) {
                const data = await response.json();
                return data.profiles || [];
            }
        } catch (e) {
            console.warn('BrowserBridge: getShellProfiles failed', e);
        }
        return [];
    }

    async getSystemInfo(): Promise<any> {
        try {
            const response = await fetch(`${API_BASE_URL}/system/info`);
            if (response.ok) return await response.json();
        } catch (e) { }
        return { platform: 'web', arch: 'unknown' };
    }

    // Configuration - Mock local storage implementation
    async getConfig(): Promise<any> {
        const stored = localStorage.getItem('auto-terminal-config');
        return stored ? JSON.parse(stored) : {};
    }

    async updateConfig(updates: any): Promise<any> {
        const current = await this.getConfig();
        const newConfig = { ...current, ...updates };
        localStorage.setItem('auto-terminal-config', JSON.stringify(newConfig));
        return newConfig;
    }

    async getConfigValue(key: string): Promise<any> {
        const config = await this.getConfig();
        return config[key];
    }

    async setConfigValue(key: string, value: any): Promise<boolean> {
        await this.updateConfig({ [key]: value });
        return true;
    }

    // No bundled resources in the browser host; legal docs are viewed on the website.
    async readLegalDocument(_name: string): Promise<string> {
        throw new Error('legal documents are not bundled in the browser host');
    }

    // Backlog 011: command history — browser build has no SQLite; degrade to
    // the localStorage-backed config store via the existing config API.
    async addCommandHistory(command: string): Promise<void> {
        try {
            const config = await this.getConfig();
            const list: string[] = Array.isArray(config.commandHistory) ? config.commandHistory : [];
            const next = [command, ...list.filter((c) => c !== command)].slice(0, 500);
            await this.updateConfig({ commandHistory: next });
        } catch (e) {
            console.error('BrowserBridge: addCommandHistory failed', e);
        }
    }

    async loadCommandHistory(limit?: number): Promise<string[]> {
        try {
            const config = await this.getConfig();
            const list: string[] = Array.isArray(config.commandHistory) ? config.commandHistory : [];
            return list.slice(0, limit ?? 2000);
        } catch (e) {
            console.error('BrowserBridge: loadCommandHistory failed', e);
            return [];
        }
    }

    async deleteCommandHistory(command: string): Promise<void> {
        try {
            const config = await this.getConfig();
            const list: string[] = Array.isArray(config.commandHistory) ? config.commandHistory : [];
            await this.updateConfig({ commandHistory: list.filter((c) => c !== command) });
        } catch (e) {
            console.error('BrowserBridge: deleteCommandHistory failed', e);
        }
    }

    async getDefaultProfile(): Promise<string> {
        return (await this.getConfigValue('defaultProfile')) || 'default';
    }

    async setDefaultProfile(profileId: string): Promise<boolean> {
        await this.setConfigValue('defaultProfile', profileId);
        return true;
    }

    async getTheme(): Promise<any> {
        return await this.getConfigValue('theme');
    }

    async setTheme(theme: any): Promise<boolean> {
        await this.setConfigValue('theme', theme);
        return true;
    }

    async generateAPIToken(_clientId: string, _permissions?: string[]): Promise<string> {
        return "mock-browser-token";
    }

    async getNetworkConfig() {
        return { apiPort: API_PORT, mcpPort: API_PORT + 1, exposeOnNetwork: false, authToken: 'mock-browser-token' };
    }

    async setNetworkConfig(apiPort: number, mcpPort: number, exposeOnNetwork: boolean) {
        return { apiPort, mcpPort, exposeOnNetwork, authToken: 'mock-browser-token' };
    }

    async rotateAuthToken() {
        return { apiPort: API_PORT, mcpPort: API_PORT + 1, exposeOnNetwork: false, authToken: 'rotated-mock-token' };
    }

    async listNetworkInterfaces() {
        return [{ name: 'lo0', label: 'loopback', ip: '127.0.0.1' }];
    }

    async stopServers(_target: 'all' | 'api' | 'mcp' = 'all'): Promise<void> {
        // No server lifecycle control in the browser host.
    }

    async startServers(_target: 'all' | 'api' | 'mcp' = 'all'): Promise<void> {
        // No server lifecycle control in the browser host.
    }

    async getAPIConfig(): Promise<{ jwtSecret: string; apiPort: number; wsPort: number; corsOrigins: string[]; autoStart: boolean; }> {
        return {
            jwtSecret: 'mock',
            apiPort: API_PORT,
            wsPort: API_PORT,
            corsOrigins: ['*'],
            autoStart: true
        };
    }

    async getActiveTabAndPane(): Promise<{ tabId: string | null; paneId: string | null; tabTitle: string | null }> {
        return { tabId: null, paneId: null, tabTitle: null };
    }

    async createTerminalInTab(_tabId: string, _paneId: string, _profile: string, _name: string): Promise<any> {
        // Not supported in bridge yet
        return null;
    }

    async getTabs(): Promise<any[]> {
        return [];
    }

    sendToMain(channel: string, data: any): void {
        console.log(`BrowserBridge: sendToMain ${channel}`, data);
    }

    async checkConnectionHealth(): Promise<Array<{name: string; url: string; healthy: boolean; active_clients?: number}>> {
        const mcpPort = API_PORT + 1;
        const connections = [
            { name: 'API Server', url: `http://localhost:${API_PORT}`, healthUrl: `http://localhost:${API_PORT}/health` },
            { name: 'MCP Server', url: `http://localhost:${mcpPort}/mcp`, healthUrl: `http://localhost:${mcpPort}/health` },
            { name: 'WebSocket', url: `ws://localhost:${API_PORT}/ws`, healthUrl: null as string | null }
        ];

        const results = await Promise.all(
            connections.map(async (conn) => {
                if (!conn.healthUrl) {
                    // WebSocket inherits API status
                    return { name: conn.name, url: conn.url, healthy: false, active_clients: undefined };
                }

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2000);
                    const response = await fetch(conn.healthUrl, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    // For MCP Server, try to parse activeSessions from response
                    if (conn.name === 'MCP Server' && response.ok) {
                        try {
                            const json = await response.json();
                            const activeClients = typeof json.activeSessions === 'number' ? json.activeSessions : undefined;
                            return { name: conn.name, url: conn.url, healthy: true, active_clients: activeClients };
                        } catch {
                            return { name: conn.name, url: conn.url, healthy: true, active_clients: undefined };
                        }
                    }

                    return { name: conn.name, url: conn.url, healthy: response.ok, active_clients: undefined };
                } catch {
                    return { name: conn.name, url: conn.url, healthy: false, active_clients: undefined };
                }
            })
        );

        // WebSocket inherits API Server status
        const apiStatus = results.find(r => r.name === 'API Server')?.healthy ?? false;
        return results.map(r => r.name === 'WebSocket' ? { ...r, healthy: apiStatus } : r);
    }

    // --- Peering (Plan 010): the fabric sidecar is Tauri-only, so the browser
    // host reports "not installed" and every action is a no-op. ---

    async peersList(): Promise<PeerInfo[]> {
        return [];
    }

    async pendingApprovalsList(): Promise<PeerRequestInfo[]> {
        return [];
    }

    async pairingCodeCreate(): Promise<PairingCode> {
        return { code: '', expiresInSecs: 0 };
    }

    async peerAdd(_address: string, _code: string): Promise<void> {
        // No fabric in the browser host.
    }

    async peerApprove(_deviceId: string, _accept: boolean): Promise<void> {
        // No fabric in the browser host.
    }

    async peerRevoke(_deviceId: string): Promise<void> {
        // No fabric in the browser host.
    }

    async peerSetGrant(_deviceId: string, _terminalId: string, _level: GrantLevel | 'None'): Promise<void> {
        // No fabric in the browser host.
    }

    async peerSetFleetExec(_deviceId: string, _enabled: boolean): Promise<void> {
        // No fabric in the browser host.
    }

    async setAcceptPeers(_enabled: boolean): Promise<void> {
        // No fabric in the browser host.
    }

    async fabricStatus(): Promise<FabricStatus> {
        return { installed: false };
    }

    // Background mode (Plan 010) is a native/tray concern — no-op in the browser host.
    async setKeepRunningInBackground(_enabled: boolean): Promise<void> {
        // No tray / background process in the browser host.
    }
}

// Singleton instance
const browserBridge = new BrowserBridge();

// Expose to window
(window as any).electronAPI = browserBridge;

export default browserBridge;
