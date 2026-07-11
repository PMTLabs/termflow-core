import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { 
  SearchQuery, 
  SearchResult, 
  SearchResponse, 
  SearchIndex, 
  SearchEngineConfig,
  SearchMatch,
  TerminalSearchHistory 
} from '../../types/search';

export class SearchService extends EventEmitter {
  private config: SearchEngineConfig;
  private searchIndex: Map<string, SearchIndex> = new Map();
  private terminalHistory: Map<string, TerminalSearchHistory> = new Map();
  private indexPath: string;
  private batchBuffer: SearchIndex[] = [];
  // private _lastFlush: number = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: SearchEngineConfig) {
    super();
    this.config = {
      ...config,
      maxIndexSize: config.maxIndexSize || 100, // 100MB default
      maxRetentionDays: config.maxRetentionDays || 30,
      realtimeIndexing: config.realtimeIndexing !== undefined ? config.realtimeIndexing : true,
      batchSize: config.batchSize || 1000,
      compressionEnabled: config.compressionEnabled !== undefined ? config.compressionEnabled : true,
    };
    
    this.indexPath = config.indexPath || path.join(process.cwd(), 'search_index');
    this.setupSearchIndex();
    this.startBatchProcessor();
  }

  private async setupSearchIndex(): Promise<void> {
    try {
      await fs.mkdir(this.indexPath, { recursive: true });
      await this.loadExistingIndex();
    } catch (error) {
      console.error('Failed to setup search index:', error);
    }
  }

  private async loadExistingIndex(): Promise<void> {
    try {
      const indexFile = path.join(this.indexPath, 'index.json');
      const historyFile = path.join(this.indexPath, 'history.json');

      // Load search index
      try {
        const indexData = await fs.readFile(indexFile, 'utf8');
        const indexEntries = JSON.parse(indexData);
        
        for (const entry of indexEntries) {
          this.searchIndex.set(entry.id, {
            ...entry,
            timestamp: new Date(entry.timestamp)
          });
        }
        
        console.log(`Loaded ${this.searchIndex.size} search index entries`);
      } catch (err) {
        console.log('No existing search index found, starting fresh');
      }

      // Load search history
      try {
        const historyData = await fs.readFile(historyFile, 'utf8');
        const historyEntries = JSON.parse(historyData);
        
        for (const entry of historyEntries) {
          this.terminalHistory.set(entry.terminalId, {
            ...entry,
            lastSearched: new Date(entry.lastSearched),
            queries: entry.queries.map((q: any) => ({
              ...q,
              timestamp: new Date(q.timestamp)
            }))
          });
        }
        
        console.log(`Loaded search history for ${this.terminalHistory.size} terminals`);
      } catch (err) {
        console.log('No existing search history found');
      }
    } catch (error) {
      console.error('Error loading search index:', error);
    }
  }

  private startBatchProcessor(): void {
    // Process batch every 5 seconds or when buffer is full
    this.flushTimer = setInterval(() => {
      if (this.batchBuffer.length > 0) {
        this.flushBatch();
      }
    }, 5000);
  }

  public indexContent(
    terminalId: string, 
    content: string, 
    type: 'output' | 'input' | 'command' | 'error',
    metadata: Record<string, any> = {}
  ): void {
    if (!content || content.trim().length === 0) {
      return;
    }

    const id = this.generateId(terminalId, content, Date.now());
    const normalizedContent = this.normalizeContent(content);
    const keywords = this.extractKeywords(content);

    const indexEntry: SearchIndex = {
      id,
      terminalId,
      content,
      normalizedContent,
      timestamp: new Date(),
      type,
      metadata,
      keywords,
      size: Buffer.byteLength(content, 'utf8')
    };

    if (this.config.realtimeIndexing) {
      this.searchIndex.set(id, indexEntry);
    } else {
      this.batchBuffer.push(indexEntry);
      
      // Flush if batch is full
      if (this.batchBuffer.length >= this.config.batchSize) {
        this.flushBatch();
      }
    }

    this.emit('contentIndexed', { terminalId, type, size: indexEntry.size });
  }

  private flushBatch(): void {
    if (this.batchBuffer.length === 0) return;

    for (const entry of this.batchBuffer) {
      this.searchIndex.set(entry.id, entry);
    }

    console.log(`Flushed ${this.batchBuffer.length} entries to search index`);
    this.batchBuffer = [];
    // this._lastFlush = Date.now();

    // Persist to disk periodically
    this.persistIndex();
  }

  public async search(query: SearchQuery, page: number = 1, pageSize: number = 50): Promise<SearchResponse> {
    const startTime = Date.now();
    
    try {
      // Normalize and prepare query
      const normalizedQuery = this.normalizeQuery(query);
      
      // Get all matching entries
      const allResults = this.performSearch(normalizedQuery);
      
      // Sort by relevance score
      allResults.sort((a, b) => b.score - a.score);
      
      // Apply pagination
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedResults = allResults.slice(startIndex, endIndex);
      
      // Generate suggestions if no results
      const suggestions = allResults.length === 0 ? this.generateSearchSuggestions(query.text) : undefined;
      
      const executionTime = Date.now() - startTime;
      
      // Record search in history
      this.recordSearchHistory(query.text, allResults.length, executionTime);
      
      return {
        results: paginatedResults,
        total: allResults.length,
        page,
        pageSize,
        query,
        executionTime,
        suggestions
      };
    } catch (error) {
      console.error('Search error:', error);
      throw new Error(`Search failed: ${error}`);
    }
  }

  private normalizeQuery(query: SearchQuery): SearchQuery {
    let normalizedText = query.text;
    
    if (!query.caseSensitive) {
      normalizedText = normalizedText.toLowerCase();
    }
    
    return {
      ...query,
      text: normalizedText.trim()
    };
  }

  private performSearch(query: SearchQuery): SearchResult[] {
    const results: SearchResult[] = [];
    const searchTerm = query.text;
    
    for (const [_id, entry] of this.searchIndex.entries()) {
      // Apply terminal filter
      if (query.terminals && query.terminals.length > 0) {
        if (!query.terminals.includes(entry.terminalId)) {
          continue;
        }
      }
      
      // Apply time range filter
      if (query.timeRange) {
        if (entry.timestamp < query.timeRange.start || entry.timestamp > query.timeRange.end) {
          continue;
        }
      }
      
      // Apply other filters
      if (query.filters) {
        if (!this.applyFilters(entry, query.filters)) {
          continue;
        }
      }
      
      // Perform text search
      const matches = this.findMatches(entry, searchTerm, query);
      
      if (matches.length > 0) {
        const score = this.calculateRelevanceScore(entry, matches, searchTerm);
        const context = this.extractContext(entry.content, matches);
        
        results.push({
          id: entry.id,
          terminalId: entry.terminalId,
          timestamp: entry.timestamp,
          content: entry.content,
          context,
          matches,
          score,
          metadata: {
            type: entry.type,
            processId: entry.metadata.processId,
            shellType: entry.metadata.shellType,
            workingDirectory: entry.metadata.workingDirectory,
            lineNumber: entry.metadata.lineNumber,
            eventId: entry.metadata.eventId
          }
        });
      }
    }
    
    return results;
  }

  private findMatches(entry: SearchIndex, searchTerm: string, query: SearchQuery): SearchMatch[] {
    const content = query.caseSensitive ? entry.content : entry.normalizedContent;
    const term = query.caseSensitive ? searchTerm : searchTerm.toLowerCase();
    const matches: SearchMatch[] = [];
    
    if (query.regex) {
      try {
        const flags = query.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(term, flags);
        let match;
        
        while ((match = regex.exec(content)) !== null) {
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            line: this.getLineNumber(content, match.index),
            column: this.getColumnNumber(content, match.index)
          });
        }
      } catch (error) {
        // Invalid regex, fall back to literal search
        return this.findLiteralMatches(content, term, query.wholeWord);
      }
    } else {
      return this.findLiteralMatches(content, term, query.wholeWord);
    }
    
    return matches;
  }

  private findLiteralMatches(content: string, term: string, wholeWord?: boolean): SearchMatch[] {
    const matches: SearchMatch[] = [];
    let searchIndex = 0;
    
    while (true) {
      const index = content.indexOf(term, searchIndex);
      if (index === -1) break;
      
      // Check word boundaries if wholeWord is enabled
      if (wholeWord) {
        const charBefore = index > 0 ? content[index - 1] : '';
        const charAfter = index + term.length < content.length ? content[index + term.length] : '';
        
        if (/\w/.test(charBefore) || /\w/.test(charAfter)) {
          searchIndex = index + 1;
          continue;
        }
      }
      
      matches.push({
        start: index,
        end: index + term.length,
        text: term,
        line: this.getLineNumber(content, index),
        column: this.getColumnNumber(content, index)
      });
      
      searchIndex = index + term.length;
    }
    
    return matches;
  }

  private applyFilters(entry: SearchIndex, filters: any[]): boolean {
    for (const filter of filters) {
      switch (filter.type) {
        case 'content_type':
          if (entry.type !== filter.value) return false;
          break;
        case 'size':
          if (!this.compareNumbers(entry.size, filter.value, filter.operator)) return false;
          break;
        // Add more filter types as needed
      }
    }
    return true;
  }

  private compareNumbers(actual: number, expected: number, operator: string = 'equals'): boolean {
    switch (operator) {
      case 'equals': return actual === expected;
      case 'greater_than': return actual > expected;
      case 'less_than': return actual < expected;
      default: return actual === expected;
    }
  }

  private calculateRelevanceScore(entry: SearchIndex, matches: SearchMatch[], searchTerm: string): number {
    let score = 0;
    
    // Base score from number of matches
    score += matches.length * 10;
    
    // Boost score for exact matches
    const exactMatches = matches.filter(m => m.text === searchTerm);
    score += exactMatches.length * 20;
    
    // Boost score for keyword matches
    const keywordMatches = entry.keywords.filter(k => 
      k.toLowerCase().includes(searchTerm.toLowerCase())
    );
    score += keywordMatches.length * 15;
    
    // Boost score for recent content
    const age = Date.now() - entry.timestamp.getTime();
    const dayInMs = 24 * 60 * 60 * 1000;
    if (age < dayInMs) score += 10;
    else if (age < 7 * dayInMs) score += 5;
    
    // Boost score for commands and errors
    if (entry.type === 'command') score += 15;
    if (entry.type === 'error') score += 20;
    
    return score;
  }

  private extractContext(content: string, matches: SearchMatch[], contextSize: number = 100): string {
    if (matches.length === 0) return content.substring(0, contextSize);
    
    const firstMatch = matches[0];
    const start = Math.max(0, firstMatch.start - contextSize / 2);
    const end = Math.min(content.length, firstMatch.end + contextSize / 2);
    
    let context = content.substring(start, end);
    
    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < content.length) context = context + '...';
    
    return context;
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private getColumnNumber(content: string, index: number): number {
    const beforeIndex = content.substring(0, index);
    const lastNewline = beforeIndex.lastIndexOf('\n');
    return index - lastNewline;
  }

  private generateSearchSuggestions(query: string): string[] {
    const suggestions: string[] = [];
    const queryLower = query.toLowerCase();
    
    // Get common keywords from index
    const keywordCounts = new Map<string, number>();
    
    for (const entry of this.searchIndex.values()) {
      for (const keyword of entry.keywords) {
        const keywordLower = keyword.toLowerCase();
        if (keywordLower.includes(queryLower) || queryLower.includes(keywordLower)) {
          keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
        }
      }
    }
    
    // Sort by frequency and take top 5
    const sortedKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([keyword]) => keyword);
    
    suggestions.push(...sortedKeywords);
    
    return suggestions;
  }

  private recordSearchHistory(query: string, resultCount: number, executionTime: number): void {
    // This would typically be associated with specific terminals
    // For now, we'll just track general search history
    const historyItem = {
      query,
      timestamp: new Date(),
      resultCount,
      executionTime
    };
    
    // Add to general search history or per-terminal history as needed
    this.emit('searchRecorded', historyItem);
  }

  private normalizeContent(content: string): string {
    return content.toLowerCase().trim();
  }

  private extractKeywords(content: string): string[] {
    // Extract potential keywords (commands, paths, etc.)
    const keywords: string[] = [];
    
    // Extract words longer than 2 characters
    const words = content.match(/\b\w{3,}\b/g);
    if (words) {
      keywords.push(...words);
    }
    
    // Extract file paths
    const paths = content.match(/[\/\\][\w\/\\.-]+/g);
    if (paths) {
      keywords.push(...paths);
    }
    
    // Extract commands (words at start of line)
    const commands = content.match(/^\w+/gm);
    if (commands) {
      keywords.push(...commands);
    }
    
    return [...new Set(keywords)]; // Remove duplicates
  }

  private generateId(terminalId: string, content: string, timestamp: number): string {
    const hash = crypto.createHash('md5');
    hash.update(`${terminalId}:${timestamp}:${content.substring(0, 100)}`);
    return hash.digest('hex');
  }

  public async clearIndex(): Promise<void> {
    this.searchIndex.clear();
    this.batchBuffer = [];
    await this.persistIndex();
    this.emit('indexCleared');
  }

  public async clearTerminalIndex(terminalId: string): Promise<void> {
    const entriesRemoved = Array.from(this.searchIndex.keys())
      .filter(key => this.searchIndex.get(key)?.terminalId === terminalId);
    
    for (const key of entriesRemoved) {
      this.searchIndex.delete(key);
    }
    
    await this.persistIndex();
    this.emit('terminalIndexCleared', { terminalId, entriesRemoved: entriesRemoved.length });
  }

  private async persistIndex(): Promise<void> {
    try {
      const indexFile = path.join(this.indexPath, 'index.json');
      const historyFile = path.join(this.indexPath, 'history.json');
      
      // Save search index
      const indexEntries = Array.from(this.searchIndex.values());
      await fs.writeFile(indexFile, JSON.stringify(indexEntries, null, 2));
      
      // Save search history
      const historyEntries = Array.from(this.terminalHistory.values());
      await fs.writeFile(historyFile, JSON.stringify(historyEntries, null, 2));
      
    } catch (error) {
      console.error('Failed to persist search index:', error);
    }
  }

  public getIndexStats(): any {
    const totalEntries = this.searchIndex.size;
    const totalSize = Array.from(this.searchIndex.values())
      .reduce((sum, entry) => sum + entry.size, 0);
    
    const typeDistribution = new Map<string, number>();
    const terminalDistribution = new Map<string, number>();
    
    for (const entry of this.searchIndex.values()) {
      typeDistribution.set(entry.type, (typeDistribution.get(entry.type) || 0) + 1);
      terminalDistribution.set(entry.terminalId, (terminalDistribution.get(entry.terminalId) || 0) + 1);
    }
    
    return {
      totalEntries,
      totalSize,
      typeDistribution: Object.fromEntries(typeDistribution),
      terminalDistribution: Object.fromEntries(terminalDistribution),
      oldestEntry: this.getOldestEntry(),
      newestEntry: this.getNewestEntry()
    };
  }

  private getOldestEntry(): Date | null {
    let oldest: Date | null = null;
    for (const entry of this.searchIndex.values()) {
      if (!oldest || entry.timestamp < oldest) {
        oldest = entry.timestamp;
      }
    }
    return oldest;
  }

  private getNewestEntry(): Date | null {
    let newest: Date | null = null;
    for (const entry of this.searchIndex.values()) {
      if (!newest || entry.timestamp > newest) {
        newest = entry.timestamp;
      }
    }
    return newest;
  }

  public async cleanup(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    // Flush any remaining batch items
    this.flushBatch();
    
    // Clean up old entries based on retention policy
    await this.cleanupOldEntries();
    
    // Persist final state
    await this.persistIndex();
  }

  private async cleanupOldEntries(): Promise<void> {
    const cutoffTime = Date.now() - (this.config.maxRetentionDays * 24 * 60 * 60 * 1000);
    const cutoffDate = new Date(cutoffTime);
    
    const entriesRemoved: string[] = [];
    
    for (const [id, entry] of this.searchIndex.entries()) {
      if (entry.timestamp < cutoffDate) {
        this.searchIndex.delete(id);
        entriesRemoved.push(id);
      }
    }
    
    if (entriesRemoved.length > 0) {
      console.log(`Cleaned up ${entriesRemoved.length} old search index entries`);
      this.emit('oldEntriesCleanedUp', { count: entriesRemoved.length });
    }
  }
}