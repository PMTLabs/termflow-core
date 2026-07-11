import { TerminalEvent, eventBus } from './EventBus';

interface BatchConfig {
  maxBatchSize: number;
  maxBatchDelay: number; // milliseconds
  enableCompression: boolean;
}

// Batch event structure for potential future use
// interface BatchedEvent {
//   events: TerminalEvent[];
//   compressed?: boolean;
// }

/**
 * Batches events for high-throughput scenarios to improve performance
 */
export class EventBatcher {
  private config: BatchConfig;
  private eventBuffer: Map<string, TerminalEvent[]>; // subscriberId -> events
  private batchTimers: Map<string, NodeJS.Timeout>;
  private subscribers: Map<string, (events: TerminalEvent[]) => void>;

  constructor(config: Partial<BatchConfig> = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize || 100,
      maxBatchDelay: config.maxBatchDelay || 16, // ~60fps for responsive feel
      enableCompression: config.enableCompression || false,
    };

    this.eventBuffer = new Map();
    this.batchTimers = new Map();
    this.subscribers = new Map();
  }

  /**
   * Subscribe to batched events
   */
  subscribeBatched(
    patterns: string | string[],
    callback: (events: TerminalEvent[]) => void,
    filter?: any
  ): { id: string; unsubscribe: () => void } {
    const subscriberId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Subscribe to individual events
    const subscription = eventBus.subscribe(
      patterns,
      (event) => this.handleEvent(subscriberId, event),
      filter
    );

    this.subscribers.set(subscriberId, callback);
    this.eventBuffer.set(subscriberId, []);

    return {
      id: subscriberId,
      unsubscribe: () => {
        subscription.unsubscribe();
        this.cleanup(subscriberId);
      },
    };
  }

  private handleEvent(subscriberId: string, event: TerminalEvent): void {
    const buffer = this.eventBuffer.get(subscriberId);
    if (!buffer) return;

    buffer.push(event);

    // Check if we should flush immediately
    if (buffer.length >= this.config.maxBatchSize) {
      this.flushBatch(subscriberId);
      return;
    }

    // Set up delayed flush if not already scheduled
    if (!this.batchTimers.has(subscriberId)) {
      const timer = setTimeout(() => {
        this.flushBatch(subscriberId);
      }, this.config.maxBatchDelay);

      this.batchTimers.set(subscriberId, timer);
    }
  }

  private flushBatch(subscriberId: string): void {
    const buffer = this.eventBuffer.get(subscriberId);
    const callback = this.subscribers.get(subscriberId);

    if (!buffer || !callback || buffer.length === 0) return;

    // Clear timer
    const timer = this.batchTimers.get(subscriberId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(subscriberId);
    }

    // Get events and clear buffer
    const events = [...buffer];
    buffer.length = 0;

    // Compress if needed
    if (this.config.enableCompression) {
      const compressedEvents = this.compressEvents(events);
      callback(compressedEvents);
    } else {
      callback(events);
    }
  }

  private compressEvents(events: TerminalEvent[]): TerminalEvent[] {
    // Group consecutive output.data events from same terminal
    const compressed: TerminalEvent[] = [];
    let currentGroup: TerminalEvent | null = null;

    for (const event of events) {
      if (event.type === 'output.data' && currentGroup?.type === 'output.data' &&
        event.terminalId === currentGroup.terminalId &&
        event.processId === currentGroup.processId) {
        // Merge with current group
        currentGroup.data.content += event.data.content;
        currentGroup.data.bytesWritten = (currentGroup.data.bytesWritten || 0) +
          (event.data.bytesWritten || 0);
      } else {
        // Start new group
        if (currentGroup) {
          compressed.push(currentGroup);
        }
        currentGroup = { ...event };
      }
    }

    if (currentGroup) {
      compressed.push(currentGroup);
    }

    return compressed;
  }

  private cleanup(subscriberId: string): void {
    // Clear timer
    const timer = this.batchTimers.get(subscriberId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(subscriberId);
    }

    // Flush any remaining events
    this.flushBatch(subscriberId);

    // Remove from maps
    this.eventBuffer.delete(subscriberId);
    this.subscribers.delete(subscriberId);
  }

  /**
   * Force flush all batches
   */
  flushAll(): void {
    for (const subscriberId of this.subscribers.keys()) {
      this.flushBatch(subscriberId);
    }
  }

  /**
   * Get current batch sizes
   */
  getBatchStats(): Record<string, number> {
    const stats: Record<string, number> = {};

    for (const [subscriberId, buffer] of this.eventBuffer) {
      stats[subscriberId] = buffer.length;
    }

    return stats;
  }
}

// Export singleton instance
export const eventBatcher = new EventBatcher();