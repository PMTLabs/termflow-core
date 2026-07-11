export interface TerminalMetadata {
  id: string;
  name: string;
  createdAt: Date;
  tabId?: string;
  paneId?: string;
}

export class TerminalMetadataManager {
  private metadata: Map<string, TerminalMetadata> = new Map();

  setMetadata(terminalId: string, metadata: Partial<TerminalMetadata>): void {
    const existing = this.metadata.get(terminalId) || {
      id: terminalId,
      name: 'Terminal',
      createdAt: new Date()
    };
    
    this.metadata.set(terminalId, {
      ...existing,
      ...metadata
    });
  }

  getMetadata(terminalId: string): TerminalMetadata | undefined {
    return this.metadata.get(terminalId);
  }

  getName(terminalId: string): string {
    return this.metadata.get(terminalId)?.name || 'Terminal';
  }

  setName(terminalId: string, name: string): void {
    this.setMetadata(terminalId, { name });
  }

  getAllMetadata(): Map<string, TerminalMetadata> {
    return new Map(this.metadata);
  }

  delete(terminalId: string): void {
    this.metadata.delete(terminalId);
  }

  clear(): void {
    this.metadata.clear();
  }
}

// Global instance
let metadataManager: TerminalMetadataManager | null = null;

export function getTerminalMetadataManager(): TerminalMetadataManager {
  if (!metadataManager) {
    metadataManager = new TerminalMetadataManager();
  }
  return metadataManager;
}