/**
 * Smart Activity Detector - Aggregates WebSocket events to determine agent activity state
 * 
 * This detector uses a sophisticated algorithm to process process.activity and process.inactive
 * events from Auto-Terminal WebSocket to make intelligent decisions about agent activity.
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';

export interface ActivityEvent {
  terminalId: string;
  timestamp: number;
  type: 'activity' | 'inactive';
  data?: any;
}

export interface ActivityState {
  terminalId: string;
  status: 'active' | 'inactive' | 'unknown';
  confidence: number; // 0-1 confidence level
  lastActivityTime: number;
  lastInactiveTime: number;
  activityCount: number;
  inactivityCount: number;
  activityStreak: number;
  inactivityStreak: number;
  averageActivityInterval: number;
  lastDecisionTime: number;
  recentEvents: ActivityEvent[];
}

export interface ActivityDecision {
  terminalId: string;
  previousStatus: 'active' | 'inactive' | 'unknown';
  newStatus: 'active' | 'inactive';
  confidence: number;
  reason: string;
  timestamp: number;
  triggerEvent: ActivityEvent;
}

export interface ActivityDetectorConfig {
  // Time windows for analysis (in milliseconds)
  shortTermWindow: number;     // 2 minutes - for immediate detection
  mediumTermWindow: number;    // 10 minutes - for trend analysis
  longTermWindow: number;      // 30 minutes - for pattern recognition
  
  // Activity thresholds
  minActivityThreshold: number;       // Min activity events for "active" decision
  maxInactivityThreshold: number;     // Max time without activity before "inactive"
  confidenceThreshold: number;        // Min confidence for status change
  
  // Event processing
  eventBufferSize: number;           // Max events to keep in memory per terminal
  decisionCooldown: number;          // Min time between status decisions
  
  // Weights for decision algorithm
  recentEventWeight: number;         // Weight for recent events vs historical
  streakWeight: number;              // Weight for activity/inactivity streaks
  intervalWeight: number;            // Weight for activity interval patterns
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityDetectorConfig = {
  shortTermWindow: 120000,      // 2 minutes
  mediumTermWindow: 600000,     // 10 minutes  
  longTermWindow: 1800000,      // 30 minutes
  minActivityThreshold: 3,      // At least 3 activity events
  maxInactivityThreshold: 300000, // 5 minutes without activity
  confidenceThreshold: 0.7,    // 70% confidence minimum
  eventBufferSize: 100,         // Keep last 100 events per terminal
  decisionCooldown: 30000,      // 30 seconds between decisions
  recentEventWeight: 0.6,       // Recent events are more important
  streakWeight: 0.3,            // Streaks matter for patterns
  intervalWeight: 0.1           // Activity intervals provide context
};

export class ActivityDetector extends EventEmitter {
  private config: ActivityDetectorConfig;
  private terminalStates: Map<string, ActivityState> = new Map();
  private eventBuffer: Map<string, ActivityEvent[]> = new Map();
  private decisions: ActivityDecision[] = [];
  private lastCleanup: number = 0;
  private cleanupInterval: number = 300000; // 5 minutes

  constructor(config: Partial<ActivityDetectorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_ACTIVITY_CONFIG, ...config };
  }

  /**
   * Process an activity event from Auto-Terminal WebSocket
   */
  processEvent(terminalId: string, eventType: 'process.activity' | 'process.inactive', timestamp: number, data?: any): void {
    const activityEvent: ActivityEvent = {
      terminalId,
      timestamp,
      type: eventType === 'process.activity' ? 'activity' : 'inactive',
      data
    };

    // Add to event buffer
    this.addToEventBuffer(terminalId, activityEvent);

    // Get or create terminal state
    const state = this.getOrCreateTerminalState(terminalId);

    // Update state with new event
    this.updateTerminalState(state, activityEvent);

    // Make activity decision
    const decision = this.makeActivityDecision(state, activityEvent);
    if (decision) {
      this.decisions.push(decision);
      console.log(chalk.cyan(`🔍 Activity Decision: ${decision.terminalId} → ${decision.newStatus} (${Math.round(decision.confidence * 100)}% confidence) - ${decision.reason}`));
      this.emit('activityDecision', decision);
    }

    // Periodic cleanup
    this.performCleanupIfNeeded();
  }

  /**
   * Get current activity state for a terminal
   */
  getTerminalState(terminalId: string): ActivityState | undefined {
    return this.terminalStates.get(terminalId);
  }

  /**
   * Get recent decisions for analysis
   */
  getRecentDecisions(limit: number = 10): ActivityDecision[] {
    return this.decisions.slice(-limit);
  }

  /**
   * Get activity statistics for a terminal
   */
  getTerminalStats(terminalId: string): any {
    const state = this.terminalStates.get(terminalId);
    if (!state) return null;

    const events = this.eventBuffer.get(terminalId) || [];
    const now = Date.now();

    const recentActivity = events.filter(e => 
      e.type === 'activity' && 
      now - e.timestamp < this.config.shortTermWindow
    );

    const recentInactivity = events.filter(e => 
      e.type === 'inactive' && 
      now - e.timestamp < this.config.shortTermWindow
    );

    return {
      status: state.status,
      confidence: state.confidence,
      timeSinceLastActivity: now - state.lastActivityTime,
      timeSinceLastInactivity: now - state.lastInactiveTime,
      totalEvents: events.length,
      recentActivityEvents: recentActivity.length,
      recentInactivityEvents: recentInactivity.length,
      activityStreak: state.activityStreak,
      inactivityStreak: state.inactivityStreak,
      averageActivityInterval: state.averageActivityInterval
    };
  }

  private addToEventBuffer(terminalId: string, event: ActivityEvent): void {
    let events = this.eventBuffer.get(terminalId);
    if (!events) {
      events = [];
      this.eventBuffer.set(terminalId, events);
    }

    events.push(event);

    // Maintain buffer size
    if (events.length > this.config.eventBufferSize) {
      events.shift();
    }
  }

  private getOrCreateTerminalState(terminalId: string): ActivityState {
    let state = this.terminalStates.get(terminalId);
    if (!state) {
      state = {
        terminalId,
        status: 'unknown',
        confidence: 0,
        lastActivityTime: 0,
        lastInactiveTime: 0,
        activityCount: 0,
        inactivityCount: 0,
        activityStreak: 0,
        inactivityStreak: 0,
        averageActivityInterval: 0,
        lastDecisionTime: 0,
        recentEvents: []
      };
      this.terminalStates.set(terminalId, state);
    }
    return state;
  }

  private updateTerminalState(state: ActivityState, event: ActivityEvent): void {

    // Update basic counters
    if (event.type === 'activity') {
      state.activityCount++;
      state.lastActivityTime = event.timestamp;
      
      // Update activity streak
      if (state.inactivityStreak > 0) {
        state.inactivityStreak = 0;
      }
      state.activityStreak++;

      // Calculate average activity interval
      if (state.activityCount > 1) {
        const events = this.eventBuffer.get(state.terminalId) || [];
        const activityEvents = events.filter(e => e.type === 'activity').slice(-5); // Last 5 activity events
        if (activityEvents.length > 1) {
          const intervals = [];
          for (let i = 1; i < activityEvents.length; i++) {
            intervals.push(activityEvents[i].timestamp - activityEvents[i-1].timestamp);
          }
          state.averageActivityInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        }
      }
    } else {
      state.inactivityCount++;
      state.lastInactiveTime = event.timestamp;
      
      // Update inactivity streak
      if (state.activityStreak > 0) {
        state.activityStreak = 0;
      }
      state.inactivityStreak++;
    }

    // Update recent events (keep last 10)
    state.recentEvents.push(event);
    if (state.recentEvents.length > 10) {
      state.recentEvents.shift();
    }
  }

  private makeActivityDecision(state: ActivityState, triggerEvent: ActivityEvent): ActivityDecision | null {
    const now = Date.now();
    
    // Check cooldown period
    if (now - state.lastDecisionTime < this.config.decisionCooldown) {
      return null;
    }

    const events = this.eventBuffer.get(state.terminalId) || [];
    
    // Analyze different time windows
    const shortTermAnalysis = this.analyzeTimeWindow(events, now, this.config.shortTermWindow);
    const mediumTermAnalysis = this.analyzeTimeWindow(events, now, this.config.mediumTermWindow);
    
    // Calculate confidence based on multiple factors
    let activityScore = 0;
    let confidence = 0;
    let reason = '';

    // Factor 1: Recent activity events (weighted heavily) - process.activity means agent is actively running
    if (shortTermAnalysis.activityEvents >= this.config.minActivityThreshold) {
      activityScore += this.config.recentEventWeight * 1.0; // Higher weight for process.activity
      reason += `Active process (${shortTermAnalysis.activityEvents} activity events), `;
    } else if (shortTermAnalysis.activityEvents > 0) {
      // Even single process.activity event is strong indicator
      activityScore += this.config.recentEventWeight * 0.7;
      reason += `Process activity detected (${shortTermAnalysis.activityEvents} events), `;
    }

    // Factor 2: Time since last activity - process.activity is strong signal
    const timeSinceActivity = now - state.lastActivityTime;
    if (timeSinceActivity > this.config.maxInactivityThreshold) {
      activityScore -= this.config.recentEventWeight * 0.4; // Reduced penalty since process.activity is reliable
      reason += `No recent activity (${Math.round(timeSinceActivity/1000)}s), `;
    } else if (timeSinceActivity < 60000) { // Less than 1 minute - process.activity is recent
      activityScore += this.config.recentEventWeight * 0.6;
      reason += `Recent process activity (${Math.round(timeSinceActivity/1000)}s ago), `;
    }

    // Factor 2a: Trigger event is process.activity - immediate strong signal
    if (triggerEvent.type === 'activity') {
      activityScore += 0.4; // Strong boost for immediate process.activity
      reason += `Triggered by process.activity, `;
    }

    // Factor 3: Activity streaks
    if (state.activityStreak >= 3) {
      activityScore += this.config.streakWeight;
      reason += `Activity streak (${state.activityStreak}), `;
    } else if (state.inactivityStreak >= 3) {
      activityScore -= this.config.streakWeight;
      reason += `Inactivity streak (${state.inactivityStreak}), `;
    }

    // Factor 4: Activity pattern consistency
    if (state.averageActivityInterval > 0 && state.averageActivityInterval < 120000) { // Regular activity within 2 minutes
      activityScore += this.config.intervalWeight;
      reason += `Regular pattern (${Math.round(state.averageActivityInterval/1000)}s interval), `;
    }

    // Factor 5: Event ratio in medium term
    const activityRatio = mediumTermAnalysis.totalEvents > 0 
      ? mediumTermAnalysis.activityEvents / mediumTermAnalysis.totalEvents 
      : 0;
    
    if (activityRatio > 0.6) {
      activityScore += 0.2;
      reason += `High activity ratio (${Math.round(activityRatio * 100)}%), `;
    } else if (activityRatio < 0.3) {
      activityScore -= 0.2;
      reason += `Low activity ratio (${Math.round(activityRatio * 100)}%), `;
    }

    // Normalize score to 0-1 range and calculate confidence
    activityScore = Math.max(0, Math.min(1, activityScore));
    confidence = Math.abs(activityScore - 0.5) * 2; // Distance from neutral (0.5)

    // Determine new status - favor 'active' for process.activity events
    let newStatus: 'active' | 'inactive';
    
    // If triggered by process.activity, lower threshold for 'active' status
    const activeThreshold = triggerEvent.type === 'activity' ? 0.5 : 0.6;
    const inactiveThreshold = triggerEvent.type === 'activity' ? 0.3 : 0.4;
    
    if (activityScore > activeThreshold) {
      newStatus = 'active';
    } else if (activityScore < inactiveThreshold) {
      newStatus = 'inactive';
    } else {
      // Neutral zone - for process.activity events, favor active
      if (triggerEvent.type === 'activity' && activityScore > 0.4) {
        newStatus = 'active';
        reason += `Process.activity favors active, `;
      } else if (confidence < 0.8) {
        return null;
      } else {
        newStatus = activityScore > 0.5 ? 'active' : 'inactive';
      }
    }

    // Only make decision if confidence is above threshold or status is unknown
    if (confidence < this.config.confidenceThreshold && state.status !== 'unknown') {
      return null;
    }

    // Don't change if status is the same (unless confidence is very high)
    if (newStatus === state.status && confidence < 0.9) {
      return null;
    }

    // Create decision
    const decision: ActivityDecision = {
      terminalId: state.terminalId,
      previousStatus: state.status,
      newStatus,
      confidence,
      reason: reason.replace(/, $/, ''), // Remove trailing comma
      timestamp: now,
      triggerEvent
    };

    // Update state
    state.status = newStatus;
    state.confidence = confidence;
    state.lastDecisionTime = now;

    return decision;
  }

  private analyzeTimeWindow(events: ActivityEvent[], now: number, windowSize: number): {
    activityEvents: number;
    inactivityEvents: number;
    totalEvents: number;
    timeSpan: number;
  } {
    const windowStart = now - windowSize;
    const windowEvents = events.filter(e => e.timestamp >= windowStart);

    return {
      activityEvents: windowEvents.filter(e => e.type === 'activity').length,
      inactivityEvents: windowEvents.filter(e => e.type === 'inactive').length,
      totalEvents: windowEvents.length,
      timeSpan: windowSize
    };
  }

  private performCleanupIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) {
      return;
    }

    // Clean old events from buffers
    for (const [terminalId, events] of this.eventBuffer) {
      const cutoff = now - this.config.longTermWindow;
      const filteredEvents = events.filter(e => e.timestamp > cutoff);
      this.eventBuffer.set(terminalId, filteredEvents);
    }

    // Clean old decisions
    const decisionCutoff = now - this.config.longTermWindow;
    this.decisions = this.decisions.filter(d => d.timestamp > decisionCutoff);

    // Clean inactive terminal states
    for (const [terminalId, state] of this.terminalStates) {
      const lastEvent = Math.max(state.lastActivityTime, state.lastInactiveTime);
      if (now - lastEvent > this.config.longTermWindow) {
        this.terminalStates.delete(terminalId);
        this.eventBuffer.delete(terminalId);
      }
    }

    this.lastCleanup = now;
  }

  /**
   * Get detector statistics for monitoring
   */
  getDetectorStats(): any {
    return {
      trackedTerminals: this.terminalStates.size,
      totalDecisions: this.decisions.length,
      recentDecisions: this.decisions.filter(d => Date.now() - d.timestamp < 600000).length,
      config: this.config
    };
  }
}