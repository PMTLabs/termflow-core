import { EventEmitter } from 'events';

// Event types
export type TerminalEventType =
  | 'process.start'
  | 'process.exit'
  | 'process.error'
  | 'process.ready'
  | 'process.idle'
  | 'process.busy'
  | 'process.crash'
  | 'process.metrics'
  | 'process.spawn'
  | 'process.activity'
  | 'process.inactive'
  | 'process.warning'
  | 'process.command.start'     // New: Command execution started
  | 'process.command.complete' // New: Command execution completed
  | 'process.command.timeout'  // New: Command execution timed out
  | 'output.data'
  | 'output.overflow'
  | 'output.prompt.detected'   // New: Shell prompt detected (command finished)
  | 'input.data'
  | 'input.throttled'
  | 'state.change'
  | 'connection.lost';

export interface TerminalEvent {
  id: string;
  type: TerminalEventType;
  timestamp: number;
  terminalId: string;
  processId?: string;
  data: any;
}

export interface ProcessEventData {
  pid?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
  command?: string;
}

export interface CommandEventData {
  command: string;           // The command that was executed
  startTime: number;         // When the command started (timestamp)
  endTime?: number;          // When the command completed (timestamp)
  duration?: number;         // Command execution duration in ms
  exitCode?: number;         // Exit code if available
  output?: string;           // Command output
  prompt?: string;           // Shell prompt that indicates completion
  workingDirectory?: string; // Directory where command was executed
  environment?: string;      // Shell environment (bash, cmd, powershell)
}

export interface PromptDetectionData {
  prompt: string;            // The detected prompt string
  pattern: string;           // The regex pattern that matched
  confidence: number;        // Confidence level (0-1)
  previousCommand?: string;  // The command that likely finished
  timeSinceLastCommand?: number; // Time since last command input
}

export interface OutputEventData {
  content: string;
  encoding?: string;
  bytesWritten?: number;
}

export interface MetricsEventData {
  cpu: number;
  memory: number;
  uptime: number;
  io?: {
    bytesRead: number;
    bytesWritten: number;
  };
}

export interface EventFilter {
  types?: TerminalEventType[];
  terminalIds?: string[];
  processIds?: string[];
  after?: Date;
  before?: Date;
}

export interface EventSubscriber {
  id: string;
  patterns: string[];
  filter?: EventFilter;
  callback: (event: TerminalEvent) => void;
}

export interface Subscription {
  id: string;
  unsubscribe: () => void;
}

interface HistoryCriteria {
  types?: TerminalEventType[];
  terminalId?: string;
  processId?: string;
  after?: Date;
  before?: Date;
  limit?: number;
}

export class EventBus extends EventEmitter {
  private subscribers: Map<string, EventSubscriber>;
  private eventQueue: TerminalEvent[];
  private eventFilters: Map<string, EventFilter>;
  private maxHistorySize: number = 10000;
  private eventIdCounter: number = 0;

  constructor() {
    super();
    this.subscribers = new Map();
    this.eventQueue = [];
    this.eventFilters = new Map();
    this.setMaxListeners(0); // Unlimited listeners
  }

  /**
   * Publish an event to all matching subscribers
   */
  publish(event: Omit<TerminalEvent, 'id'>): void {
    const fullEvent: TerminalEvent = {
      ...event,
      id: this.generateEventId(),
      timestamp: event.timestamp || Date.now(),
    };

    // Add to history
    this.addToHistory(fullEvent);

    // Process subscribers
    for (const [subscriberId, subscriber] of this.subscribers) {
      if (this.matchesPattern(fullEvent, subscriber.patterns)) {
        const filter = this.eventFilters.get(subscriberId) || subscriber.filter;
        if (this.passesFilter(fullEvent, filter)) {
          // Call subscriber immediately for real-time event delivery
          try {
            subscriber.callback(fullEvent);
          } catch (error) {
            console.error(`Subscriber ${subscriberId} error:`, error);
            this.emit('subscriber.error', { subscriberId, error });
          }
        }
      }
    }

    // Emit for direct listeners
    this.emit(fullEvent.type, fullEvent);
    this.emit('event', fullEvent);
  }

  /**
   * Subscribe to events matching patterns
   */
  subscribe(patterns: string | string[], callback: (event: TerminalEvent) => void, filter?: EventFilter): Subscription {
    const subscriberId = this.generateSubscriberId();
    const patternArray = Array.isArray(patterns) ? patterns : [patterns];

    const subscriber: EventSubscriber = {
      id: subscriberId,
      patterns: patternArray,
      filter,
      callback,
    };

    this.subscribers.set(subscriberId, subscriber);

    return {
      id: subscriberId,
      unsubscribe: () => this.unsubscribe(subscriberId),
    };
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
    this.eventFilters.delete(subscriptionId);
  }

  /**
   * Add or update filter for a subscriber
   */
  addFilter(subscriberId: string, filter: EventFilter): void {
    if (this.subscribers.has(subscriberId)) {
      this.eventFilters.set(subscriberId, filter);
    }
  }

  /**
   * Remove filter for a subscriber
   */
  removeFilter(subscriberId: string): void {
    this.eventFilters.delete(subscriberId);
  }

  /**
   * Get event history based on criteria
   */
  getEventHistory(criteria: HistoryCriteria = {}): TerminalEvent[] {
    let events = [...this.eventQueue];

    // Apply filters
    if (criteria.types && criteria.types.length > 0) {
      events = events.filter(e => criteria.types!.includes(e.type));
    }

    if (criteria.terminalId) {
      events = events.filter(e => e.terminalId === criteria.terminalId);
    }

    if (criteria.processId) {
      events = events.filter(e => e.processId === criteria.processId);
    }

    if (criteria.after) {
      const afterTime = criteria.after.getTime();
      events = events.filter(e => e.timestamp > afterTime);
    }

    if (criteria.before) {
      const beforeTime = criteria.before.getTime();
      events = events.filter(e => e.timestamp < beforeTime);
    }

    // Apply limit
    if (criteria.limit && criteria.limit > 0) {
      events = events.slice(-criteria.limit);
    }

    return events;
  }

  /**
   * Clear event history before a certain date
   */
  clearEventHistory(before?: Date): void {
    if (!before) {
      this.eventQueue = [];
      return;
    }

    const beforeTime = before.getTime();
    this.eventQueue = this.eventQueue.filter(e => e.timestamp >= beforeTime);
  }

  /**
   * Get current number of subscribers
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Get event statistics
   */
  getEventStats(): Record<TerminalEventType, number> {
    const stats: Partial<Record<TerminalEventType, number>> = {};

    for (const event of this.eventQueue) {
      stats[event.type] = (stats[event.type] || 0) + 1;
    }

    return stats as Record<TerminalEventType, number>;
  }

  private matchesPattern(event: TerminalEvent, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === '*') return true;

      // Simple wildcard matching
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(event.type)) {
        return true;
      }
    }
    return false;
  }

  private passesFilter(event: TerminalEvent, filter?: EventFilter): boolean {
    if (!filter) return true;

    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(event.type)) return false;
    }

    if (filter.terminalIds && filter.terminalIds.length > 0) {
      if (!filter.terminalIds.includes(event.terminalId)) return false;
    }

    if (filter.processIds && filter.processIds.length > 0) {
      if (!event.processId || !filter.processIds.includes(event.processId)) return false;
    }

    if (filter.after && event.timestamp < filter.after.getTime()) return false;
    if (filter.before && event.timestamp > filter.before.getTime()) return false;

    return true;
  }

  private addToHistory(event: TerminalEvent): void {
    this.eventQueue.push(event);

    // Maintain max history size
    if (this.eventQueue.length > this.maxHistorySize) {
      this.eventQueue.shift();
    }
  }

  private generateEventId(): string {
    return `evt-${Date.now()}-${this.eventIdCounter++}`;
  }

  private generateSubscriberId(): string {
    return `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Singleton instance
export const eventBus = new EventBus();