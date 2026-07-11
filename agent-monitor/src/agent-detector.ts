/**
 * AI Agent Detection and Monitoring
 */

import { EventEmitter } from 'events';
import { AgentType, AgentDetectionPattern, OutputEvent } from './types';

export class AgentDetector extends EventEmitter {
  private patterns: AgentDetectionPattern[] = [
    {
      name: 'claude',
      startPattern: /Claude>|claude>|Human:|human>|Assistant:|Welcome to Claude|Claude Desktop|╭─/,
      promptIndicator: /^(Human:|human>|>)/m,
      responseStartPattern: /^(Assistant:|Claude>|╭─|●)/m,
      responseEndPattern: /\n\n\n|╰─+╯|\n> $/m
    },
    {
      name: 'gemini',
      startPattern: /Gemini> |You: |Model: /,
      promptIndicator: /^(You: )/m,
      responseStartPattern: /^(Model: |Gemini> )/m,
      responseEndPattern: /\n(You: |Gemini> |\$ )/
    },
    {
      name: 'chatgpt',
      startPattern: /ChatGPT> |User: |Assistant: /,
      promptIndicator: /^(User: )/m,
      responseStartPattern: /^(Assistant: |ChatGPT> )/m,
      responseEndPattern: /\n(User: |ChatGPT> |\$ )/
    }
  ];

  private buffers: Map<string, string> = new Map();
  private activeAgents: Map<string, AgentType> = new Map();
  private isCollectingPrompt: Map<string, boolean> = new Map();
  private currentPrompts: Map<string, string> = new Map();
  private isCollectingResponse: Map<string, boolean> = new Map();
  private currentResponses: Map<string, string> = new Map();
  private responseStartTime: Map<string, number> = new Map();
  private lastOutputTime: Map<string, number> = new Map();

  /**
   * Process terminal output to detect AI agent activity
   */
  processOutput(event: OutputEvent): void {
    const { terminalId, data: { content } } = event;
    
    // Add to buffer
    const buffer = this.buffers.get(terminalId) || '';
    const updatedBuffer = buffer + content;
    this.buffers.set(terminalId, updatedBuffer);
    
    // Keep buffer size reasonable (last 10KB)
    if (updatedBuffer.length > 10240) {
      this.buffers.set(terminalId, updatedBuffer.slice(-10240));
    }
    
    // Debug: Log raw content for Claude (skip pure control sequences)
    // Commented out to reduce noise - uncomment for debugging
    /*
    if (this.activeAgents.get(terminalId) === 'claude' && content.trim()) {
      // Skip logging if it's mostly control sequences
      const cleanContent = content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (cleanContent.length > 5) {
        console.log('[DEBUG] Content (cleaned):', cleanContent.substring(0, 100));
      }
    }
    */
    
    // Detect agent type if not already detected
    if (!this.activeAgents.has(terminalId)) {
      const agentType = this.detectAgentType(updatedBuffer);
      if (agentType !== 'unknown') {
        this.activeAgents.set(terminalId, agentType);
        this.emit('agentDetected', {
          terminalId,
          agentType,
          timestamp: new Date()
        });
      }
    }
    
    const agentType = this.activeAgents.get(terminalId);
    if (agentType && agentType !== 'unknown') {
      const pattern = this.patterns.find(p => p.name === agentType);
      if (pattern) {
        this.processAgentOutput(terminalId, content, pattern);
      }
    }
  }

  /**
   * Detect which AI agent is running
   */
  private detectAgentType(buffer: string): AgentType {
    for (const pattern of this.patterns) {
      if (pattern.startPattern.test(buffer)) {
        return pattern.name;
      }
    }
    return 'unknown';
  }

  /**
   * Process output for a specific agent type
   */
  private processAgentOutput(
    terminalId: string, 
    content: string, 
    pattern: AgentDetectionPattern
  ): void {
    // For Claude Desktop, we need to handle the specific format
    if (pattern.name === 'claude') {
      // Clean content from ANSI codes first
      const cleanedContent = content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      
      // Check if this is a prompt line (starts with ">")
      if (cleanedContent.startsWith('>') && !this.isCollectingResponse.get(terminalId)) {
        // Extract prompt, removing any UI elements
        let prompt = cleanedContent.replace(/^>\s*/, '');
        // Remove any trailing UI characters or commands
        prompt = prompt.replace(/[╭─╮╰╯│]/g, '').trim();
        
        if (prompt && !prompt.startsWith('/')) { // Skip slash commands
          // Avoid duplicate prompt detection
          const lastPrompt = this.currentPrompts.get(terminalId);
          if (lastPrompt !== prompt) {
            console.log('[DEBUG] Detected prompt:', prompt);
            this.currentPrompts.set(terminalId, prompt);
            this.emit('promptDetected', {
              terminalId,
              agentType: pattern.name,
              prompt: prompt,
              timestamp: new Date()
            });
          }
        }
      }
      // Check if we're collecting a response
      else if (this.isCollectingResponse.get(terminalId)) {
        const currentResponse = this.currentResponses.get(terminalId) || '';
        const updatedResponse = currentResponse + content;
        this.currentResponses.set(terminalId, updatedResponse);
        this.lastOutputTime.set(terminalId, Date.now());
        
        // Log meaningful chunks for debugging
        const cleanChunk = content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        if (cleanChunk && !cleanChunk.match(/^[╭─╮╰╯│\s]+$/)) {
          console.log('[DEBUG] Response chunk:', cleanChunk.substring(0, 100));
        }
        
        // Claude Desktop ends responses with the box drawing bottom line
        if (content.includes('╰─') || content.includes('╯')) {
          console.log('[DEBUG] Found end marker, waiting for completion');
          
          // Wait a bit to ensure we have all the content
          setTimeout(() => {
            this.completeClaudeResponse(terminalId, pattern.name);
          }, 500);
        } else {
          // Also check for a new prompt line appearing (means response is done)
          if (cleanedContent.includes('>') && cleanedContent.includes('?')) {
            console.log('[DEBUG] Found new prompt line, completing response');
            setTimeout(() => {
              this.completeClaudeResponse(terminalId, pattern.name);
            }, 100);
          } else {
            // Also check for timeout - if no new output for 2 seconds, consider response complete
            setTimeout(() => {
              const lastTime = this.lastOutputTime.get(terminalId) || 0;
              if (Date.now() - lastTime > 2000 && this.isCollectingResponse.get(terminalId)) {
                console.log('[DEBUG] Response timeout (2s), completing');
                this.completeClaudeResponse(terminalId, pattern.name);
              }
            }, 2500);
          }
        }
      }
      // Check for response start markers (● or processing indicators)
      else if (!this.isCollectingResponse.get(terminalId)) {
        // Look for the bullet marker
        if (cleanedContent.includes('●')) {
          console.log('[DEBUG] Found response start marker ●');
          this.isCollectingResponse.set(terminalId, true);
          this.responseStartTime.set(terminalId, Date.now());
          this.lastOutputTime.set(terminalId, Date.now());
          // Include the content with the bullet
          this.currentResponses.set(terminalId, content);
        }
        // Also check for processing indicators that might come before the bullet
        else if (cleanedContent.match(/·\s*(Noodling|Contemplating|Germinating|Puttering|Enchanting)/)) {
          console.log('[DEBUG] Found processing indicator, waiting for response');
          // Don't start collecting yet, wait for the bullet
        }
      }
      return;
    }
    
    // Original logic for other agents
    // Check if we're collecting a prompt
    if (this.isCollectingPrompt.get(terminalId)) {
      const currentPrompt = this.currentPrompts.get(terminalId) || '';
      const updatedPrompt = currentPrompt + content;
      this.currentPrompts.set(terminalId, updatedPrompt);
      
      // Check if prompt is complete (usually ends with escape sequence or specific pattern)
      if (content.includes('\u001b') || content.includes('\r\r')) {
        this.isCollectingPrompt.set(terminalId, false);
        const fullPrompt = updatedPrompt.replace(/\u001b\r\r$/, '').trim();
        
        this.emit('promptDetected', {
          terminalId,
          agentType: pattern.name,
          prompt: fullPrompt,
          timestamp: new Date()
        });
        
        // Start collecting response
        this.isCollectingResponse.set(terminalId, true);
        this.currentResponses.set(terminalId, '');
        this.currentPrompts.set(terminalId, '');
      }
    }
    // Check if we should start collecting a prompt
    else if (pattern.promptIndicator.test(content)) {
      this.isCollectingPrompt.set(terminalId, true);
      // Remove the prompt indicator from the content
      const cleanContent = content.replace(pattern.promptIndicator, '');
      this.currentPrompts.set(terminalId, cleanContent);
    }
    // Check if we're collecting a response
    else if (this.isCollectingResponse.get(terminalId)) {
      const currentResponse = this.currentResponses.get(terminalId) || '';
      const updatedResponse = currentResponse + content;
      this.currentResponses.set(terminalId, updatedResponse);
      
      // Check if response is complete
      if (pattern.responseEndPattern.test(updatedResponse)) {
        this.isCollectingResponse.set(terminalId, false);
        const fullResponse = updatedResponse.replace(pattern.responseEndPattern, '').trim();
        
        this.emit('responseCompleted', {
          terminalId,
          agentType: pattern.name,
          response: fullResponse,
          timestamp: new Date()
        });
        
        this.currentResponses.set(terminalId, '');
      }
    }
    // Check if this starts a response
    else if (pattern.responseStartPattern.test(content)) {
      this.isCollectingResponse.set(terminalId, true);
      const cleanContent = content.replace(pattern.responseStartPattern, '');
      this.currentResponses.set(terminalId, cleanContent);
    }
  }

  /**
   * Complete Claude response processing
   */
  private completeClaudeResponse(terminalId: string, agentType: string): void {
    if (!this.isCollectingResponse.get(terminalId)) return;
    
    this.isCollectingResponse.set(terminalId, false);
    const fullResponse = this.currentResponses.get(terminalId) || '';
    
    // First, remove all ANSI escape sequences
    let cleanResponse = fullResponse.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    
    console.log('[DEBUG] Processing response, raw length:', fullResponse.length);
    console.log('[DEBUG] Response after ANSI removal (first 500):', cleanResponse.substring(0, 500));
    
    // Look for the actual response content pattern
    // Claude Desktop shows responses after the ● marker
    const bulletIndex = cleanResponse.indexOf('●');
    if (bulletIndex !== -1) {
      // Get everything after the bullet
      cleanResponse = cleanResponse.substring(bulletIndex + 1);
      
      // Find where the response ends (before the box drawing or next prompt)
      const endMatch = cleanResponse.match(/(.+?)(?:╰─|╯|\n\s*>\s*(?:\n|$))/s);
      if (endMatch) {
        cleanResponse = endMatch[1];
      } else {
        // If no end marker found, look for the prompt return
        const promptIndex = cleanResponse.lastIndexOf('\n>');
        if (promptIndex !== -1) {
          cleanResponse = cleanResponse.substring(0, promptIndex);
        }
      }
    }
    
    // Clean up UI elements but preserve the response structure
    cleanResponse = cleanResponse
      .replace(/[╭─╮╰╯│]/g, '') // Remove box drawing
      .replace(/\r/g, '') // Remove carriage returns
      .trim();
    
    console.log('[DEBUG] After UI cleanup:', cleanResponse.substring(0, 300));
    
    // Split into lines and filter carefully
    const lines = cleanResponse.split('\n');
    const responseLines: string[] = [];
    let foundContent = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines before content
      if (!trimmed && !foundContent) continue;
      
      // Skip UI elements
      if (trimmed.match(/^\? for shortcuts/)) continue;
      if (trimmed.match(/^>\s*$/)) break; // Stop at prompt
      if (trimmed.match(/^·.*(?:tokens|interrupt|esc)/)) continue;
      if (trimmed.match(/^(?:Noodling|Contemplating|Germinating|Puttering|Enchanting|Actualizing|Considering)[…….]/)) continue;
      
      // This looks like actual content
      if (trimmed) {
        foundContent = true;
        responseLines.push(line); // Keep original line with indentation
      }
    }
    
    cleanResponse = responseLines.join('\n').trim();
    
    console.log('[DEBUG] Final clean response:', JSON.stringify(cleanResponse));
    
    if (cleanResponse && cleanResponse.length > 5) {
      console.log('[DEBUG] Emitting responseCompleted event');
      this.emit('responseCompleted', {
        terminalId,
        agentType,
        response: cleanResponse,
        timestamp: new Date()
      });
    } else {
      console.log('[DEBUG] Response too short or empty, not emitting event');
    }
    
    this.currentResponses.set(terminalId, '');
    this.responseStartTime.delete(terminalId);
    this.lastOutputTime.delete(terminalId);
  }

  /**
   * Clear state for a terminal
   */
  clearTerminal(terminalId: string): void {
    this.buffers.delete(terminalId);
    this.activeAgents.delete(terminalId);
    this.isCollectingPrompt.delete(terminalId);
    this.currentPrompts.delete(terminalId);
    this.isCollectingResponse.delete(terminalId);
    this.currentResponses.delete(terminalId);
    this.responseStartTime.delete(terminalId);
    this.lastOutputTime.delete(terminalId);
  }

  /**
   * Get active agent for a terminal
   */
  getActiveAgent(terminalId: string): AgentType | undefined {
    return this.activeAgents.get(terminalId);
  }

  /**
   * Add custom agent pattern
   */
  addPattern(pattern: AgentDetectionPattern): void {
    this.patterns.push(pattern);
  }
}