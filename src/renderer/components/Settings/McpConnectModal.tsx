import React, { useId, useRef, useState } from 'react';
import { NetworkInterfaceInfo } from '../../types/electron';
import { buildMcpConfig, McpClient } from './mcpConfig';
import { useDialogA11y, Mnemonic as MnemonicType } from '../UI/useDialogA11y';
import { Mnemonic } from '../UI/Mnemonic';

interface McpConnectModalProps {
    interfaces: NetworkInterfaceInfo[];
    mcpPort: number;
    token: string;
    onClose: () => void;
}

/**
 * Popup showing a paste-ready `mcpServers` config block for connecting an AI
 * agent to this app's MCP server. The interface picker rewrites the host IP so
 * the copied block targets whichever NIC the user wants. The token rides an
 * HTTP `Authorization: Bearer` header (an `env` map is ignored by HTTP MCP
 * clients); the agent picker switches between the Claude Code, Codex, and Gemini
 * CLI config shapes, which differ.
 *
 * The block also wires the `X-Termflow-Terminal-Id` header (env-expanding the
 * per-terminal `TERMFLOW_TERMINAL_ID` var) so the agent's `get_my_terminal` /
 * `"me"` resolves to its own terminal. Gemini omits it (Gemini doesn't expand env
 * vars inside `headers`); Gemini users pass the id explicitly instead.
 */
export const McpConnectModal: React.FC<McpConnectModalProps> = ({ interfaces, mcpPort, token, onClose }) => {
    const options = interfaces.length > 0 ? interfaces : [{ name: 'lo0', label: 'loopback', ip: '127.0.0.1' }];
    const [selectedIp, setSelectedIp] = useState<string>(options[0].ip);
    const [client, setClient] = useState<McpClient>('claude');
    const [copied, setCopied] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    const configBlock = buildMcpConfig({ client, ip: selectedIp, port: mcpPort, token });

    const copyBlock = async () => {
        try {
            await navigator.clipboard.writeText(configBlock);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy MCP config:', err);
        }
    };

    // No free-text input (only selects, which suppress mnemonics while focused via
    // type-ahead), so C=Copy / D=Done stay active when focus is on a button.
    const mnemonics: MnemonicType[] = [
        { key: 'C', handler: () => { void copyBlock(); } },
        { key: 'D', handler: onClose },
    ];

    useDialogA11y(containerRef, {
        isOpen: true,
        onCancel: onClose,
        mnemonics,
        initialFocus: 'confirm',
    });

    return (
        // Backdrop intentionally does NOT close on click — only the ✕/Done button or
        // Esc dismisses the popup, so an accidental outside click won't lose the config.
        <div className="mcp-modal-overlay">
            <div
                className="mcp-modal"
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
            >
                <div className="mcp-modal-header">
                    <h3 id={titleId}>Connect an AI agent (MCP)</h3>
                    <button className="mcp-modal-close" onClick={onClose} aria-label="Close">✕</button>
                </div>

                <div className="mcp-modal-body">
                    <label className="setting-label">Interface</label>
                    <select
                        className="setting-input"
                        value={selectedIp}
                        onChange={(e) => setSelectedIp(e.target.value)}
                    >
                        {options.map((iface) => (
                            <option key={`${iface.name}-${iface.ip}`} value={iface.ip}>
                                {iface.name} — {iface.ip} ({iface.label})
                            </option>
                        ))}
                    </select>

                    <label className="setting-label">Agent</label>
                    <select
                        className="setting-input"
                        value={client}
                        onChange={(e) => setClient(e.target.value as McpClient)}
                    >
                        <option value="claude">Claude Code</option>
                        <option value="codex">Codex</option>
                        <option value="gemini">Gemini CLI</option>
                    </select>

                    <div className="mcp-config-header">
                        <span>Paste into your agent's MCP config:</span>
                        <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={copyBlock}>
                            {copied ? 'Copied!' : <Mnemonic label="Copy" char="C" />}
                        </button>
                    </div>
                    <pre className="mcp-config-block"><code>{configBlock}</code></pre>

                    <p className="help-text">
                        The token is sent as an <code>Authorization: Bearer</code> header, which the
                        app validates. Treat the copied block as a secret; rotating the token in
                        Settings invalidates the old one.
                    </p>
                    <p className="help-text">
                        The <code>X-Termflow-Terminal-Id</code> header lets the agent identify its own
                        terminal (<code>get_my_terminal</code> / <code>"me"</code>) by expanding the
                        <code> TERMFLOW_TERMINAL_ID</code> env var that's injected into every terminal.
                        {client === 'gemini'
                            ? ' Gemini CLI does not expand env vars in headers, so it\'s omitted here — pass $TERMFLOW_TERMINAL_ID explicitly as the terminalId instead.'
                            : ''}
                    </p>
                </div>

                <div className="mcp-modal-footer">
                    <button className="save-btn" data-dialog-confirm onClick={onClose}>
                        <Mnemonic label="Done" char="D" />
                    </button>
                </div>
            </div>
        </div>
    );
};
