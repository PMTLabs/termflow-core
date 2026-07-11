/**
 * Prompt Session Management
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { PromptSession, AgentType } from './types';

export class PromptManager extends EventEmitter {
  private sessions: Map<string, PromptSession> = new Map();
  private terminalSessions: Map<string, string[]> = new Map();

  /**
   * Start a new prompt session
   */
  startSession(terminalId: string, agentType: AgentType, prompt: string): PromptSession {
    const session: PromptSession = {
      id: uuidv4(),
      terminalId,
      agentType,
      prompt,
      startTime: new Date(),
      status: 'executing'
    };
    
    this.sessions.set(session.id, session);
    
    // Track session by terminal
    const terminalSessionIds = this.terminalSessions.get(terminalId) || [];
    terminalSessionIds.push(session.id);
    this.terminalSessions.set(terminalId, terminalSessionIds);
    
    this.emit('sessionStarted', session);
    return session;
  }

  /**
   * Complete a prompt session
   */
  completeSession(sessionId: string, response: string): PromptSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'executing') {
      return null;
    }
    
    session.endTime = new Date();
    session.duration = session.endTime.getTime() - session.startTime.getTime();
    session.status = 'completed';
    session.response = response;
    
    this.emit('sessionCompleted', session);
    return session;
  }

  /**
   * Find the active session for a terminal
   */
  getActiveSession(terminalId: string): PromptSession | null {
    const sessionIds = this.terminalSessions.get(terminalId) || [];
    
    for (const sessionId of sessionIds.reverse()) {
      const session = this.sessions.get(sessionId);
      if (session && session.status === 'executing') {
        return session;
      }
    }
    
    return null;
  }

  /**
   * Get all sessions for a terminal
   */
  getTerminalSessions(terminalId: string): PromptSession[] {
    const sessionIds = this.terminalSessions.get(terminalId) || [];
    return sessionIds
      .map(id => this.sessions.get(id))
      .filter((session): session is PromptSession => session !== undefined);
  }

  /**
   * Get session statistics
   */
  getStatistics(terminalId?: string): {
    totalSessions: number;
    completedSessions: number;
    averageDuration: number;
    sessionsByAgent: Record<AgentType, number>;
  } {
    const sessions = terminalId 
      ? this.getTerminalSessions(terminalId)
      : Array.from(this.sessions.values());
    
    const completedSessions = sessions.filter(s => s.status === 'completed');
    const totalDuration = completedSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    
    const sessionsByAgent = sessions.reduce((acc, s) => {
      acc[s.agentType] = (acc[s.agentType] || 0) + 1;
      return acc;
    }, {} as Record<AgentType, number>);
    
    return {
      totalSessions: sessions.length,
      completedSessions: completedSessions.length,
      averageDuration: completedSessions.length > 0 
        ? Math.round(totalDuration / completedSessions.length)
        : 0,
      sessionsByAgent
    };
  }

  /**
   * Clear sessions for a terminal
   */
  clearTerminal(terminalId: string): void {
    const sessionIds = this.terminalSessions.get(terminalId) || [];
    sessionIds.forEach(id => this.sessions.delete(id));
    this.terminalSessions.delete(terminalId);
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): PromptSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get recent sessions
   */
  getRecentSessions(limit: number = 10): PromptSession[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }
}