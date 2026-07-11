interface QueuedMessage {
  id: string;
  timestamp: number;
  type: string;
  data: any;
  terminalId?: string;
  retryCount?: number;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private maxSize = 1000;
  private storageKey = 'terminal-monitor-message-queue';

  constructor() {
    this.loadPersistedQueue();
  }

  /**
   * Add a message to the queue
   */
  enqueue(message: Omit<QueuedMessage, 'id' | 'timestamp'>): void {
    const queuedMessage: QueuedMessage = {
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
      retryCount: message.retryCount || 0,
    };

    this.queue.push(queuedMessage);

    // Maintain max size by removing oldest messages
    if (this.queue.length > this.maxSize) {
      this.queue.shift();
    }

    this.persistQueue();
  }

  /**
   * Get and remove all messages from the queue
   */
  dequeueAll(): QueuedMessage[] {
    const messages = [...this.queue];
    this.queue = [];
    this.clearPersistedQueue();
    return messages;
  }

  /**
   * Get messages without removing them
   */
  peek(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Get messages for a specific terminal
   */
  getByTerminalId(terminalId: string): QueuedMessage[] {
    return this.queue.filter((msg) => msg.terminalId === terminalId);
  }

  /**
   * Remove specific messages by ID
   */
  removeByIds(ids: string[]): void {
    this.queue = this.queue.filter((msg) => !ids.includes(msg.id));
    this.persistQueue();
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.queue = [];
    this.clearPersistedQueue();
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Persist queue to localStorage
   */
  private persistQueue(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
    } catch (error) {
      console.error('Failed to persist message queue:', error);
      // If storage is full, remove oldest messages and try again
      if (this.queue.length > 10) {
        this.queue = this.queue.slice(-10);
        try {
          localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
        } catch (retryError) {
          console.error('Failed to persist reduced queue:', retryError);
        }
      }
    }
  }

  /**
   * Load persisted queue from localStorage
   */
  private loadPersistedQueue(): void {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          // Filter out messages older than 24 hours
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          this.queue = parsed.filter((msg) => msg.timestamp > oneDayAgo);

          // Re-persist if we filtered out old messages
          if (this.queue.length !== parsed.length) {
            this.persistQueue();
          }
        }
      }
    } catch (error) {
      console.error('Failed to load persisted message queue:', error);
      this.clearPersistedQueue();
    }
  }

  /**
   * Clear persisted queue from localStorage
   */
  private clearPersistedQueue(): void {
    try {
      localStorage.removeItem(this.storageKey);
    } catch (error) {
      console.error('Failed to clear persisted queue:', error);
    }
  }

  /**
   * Generate unique ID for messages
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Singleton instance
export const messageQueue = new MessageQueue();
