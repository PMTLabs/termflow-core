import { Request, Response } from 'express';
import { SearchService } from '../main/services/SearchService';
import { SearchQuery } from '../types/search';
import { authMiddleware, Permissions } from './auth';

export class SearchEndpoints {
  constructor(private searchService: SearchService) {}

  public setupRoutes(app: any, authManager: any): void {
    const auth = authMiddleware.bind(null, authManager);

    // Search endpoints
    app.get('/api/search', 
      auth(Permissions.TERMINAL_READ), 
      this.searchContent.bind(this)
    );
    
    app.post('/api/search', 
      auth(Permissions.TERMINAL_READ), 
      this.advancedSearch.bind(this)
    );
    
    app.get('/api/search/suggestions', 
      auth(Permissions.TERMINAL_READ), 
      this.getSearchSuggestions.bind(this)
    );

    // Index management endpoints
    app.post('/api/search/index/content', 
      auth(Permissions.TERMINAL_WRITE), 
      this.indexContent.bind(this)
    );
    
    app.delete('/api/search/index', 
      auth(Permissions.TERMINAL_DELETE), 
      this.clearIndex.bind(this)
    );
    
    app.delete('/api/search/index/terminal/:terminalId', 
      auth(Permissions.TERMINAL_DELETE), 
      this.clearTerminalIndex.bind(this)
    );

    // Search statistics and management
    app.get('/api/search/stats', 
      auth(Permissions.SYSTEM_INFO), 
      this.getSearchStats.bind(this)
    );

    app.get('/api/search/history', 
      auth(Permissions.TERMINAL_READ), 
      this.getSearchHistory.bind(this)
    );
  }

  private async searchContent(req: Request, res: Response): Promise<void> {
    try {
      const { 
        q, 
        terminals, 
        startDate, 
        endDate, 
        type, 
        page = 1, 
        pageSize = 50,
        caseSensitive = false,
        regex = false,
        wholeWord = false,
        highlight = true
      } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const query: SearchQuery = {
        text: q,
        caseSensitive: caseSensitive === 'true',
        regex: regex === 'true',
        wholeWord: wholeWord === 'true',
        highlight: highlight === 'true'
      };

      // Add terminal filter
      if (terminals) {
        const terminalList = Array.isArray(terminals) ? terminals : [terminals];
        query.terminals = terminalList as string[];
      }

      // Add time range filter
      if (startDate && endDate) {
        query.timeRange = {
          start: new Date(startDate as string),
          end: new Date(endDate as string)
        };
      }

      // Add content type filter
      if (type) {
        query.filters = [{
          type: 'content_type',
          value: type,
          operator: 'equals'
        }];
      }

      const pageNum = parseInt(page as string) || 1;
      const pageSizeNum = parseInt(pageSize as string) || 50;

      const results = await this.searchService.search(query, pageNum, pageSizeNum);
      res.json(results);
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async advancedSearch(req: Request, res: Response): Promise<void> {
    try {
      const { query, page = 1, pageSize = 50 } = req.body;

      if (!query || !query.text) {
        res.status(400).json({ error: 'Query object with text property is required' });
        return;
      }

      // Validate query structure
      const searchQuery: SearchQuery = {
        text: query.text,
        terminals: query.terminals,
        timeRange: query.timeRange ? {
          start: new Date(query.timeRange.start),
          end: new Date(query.timeRange.end)
        } : undefined,
        filters: query.filters,
        highlight: query.highlight !== false, // Default to true
        caseSensitive: query.caseSensitive || false,
        regex: query.regex || false,
        wholeWord: query.wholeWord || false
      };

      const results = await this.searchService.search(searchQuery, page, pageSize);
      res.json(results);
    } catch (error: any) {
      console.error('Advanced search error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getSearchSuggestions(req: Request, res: Response): Promise<void> {
    try {
      const { q, limit = 10 } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      // Perform a search to get suggestions from the search service
      const query: SearchQuery = { text: q };
      const results = await this.searchService.search(query, 1, 1);
      
      const suggestions = results.suggestions || [];
      const limitNum = parseInt(limit as string) || 10;
      
      res.json({
        query: q,
        suggestions: suggestions.slice(0, limitNum)
      });
    } catch (error: any) {
      console.error('Search suggestions error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async indexContent(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId, content, type = 'output', metadata = {} } = req.body;

      if (!terminalId || !content) {
        res.status(400).json({ 
          error: 'terminalId and content are required' 
        });
        return;
      }

      if (!['output', 'input', 'command', 'error'].includes(type)) {
        res.status(400).json({ 
          error: 'type must be one of: output, input, command, error' 
        });
        return;
      }

      this.searchService.indexContent(terminalId, content, type, metadata);

      res.status(201).json({
        success: true,
        message: 'Content indexed successfully',
        terminalId,
        type,
        size: Buffer.byteLength(content, 'utf8')
      });
    } catch (error: any) {
      console.error('Index content error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async clearIndex(_req: Request, res: Response): Promise<void> {
    try {
      await this.searchService.clearIndex();
      
      res.json({
        success: true,
        message: 'Search index cleared successfully'
      });
    } catch (error: any) {
      console.error('Clear index error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async clearTerminalIndex(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId } = req.params;

      if (!terminalId) {
        res.status(400).json({ error: 'Terminal ID is required' });
        return;
      }

      await this.searchService.clearTerminalIndex(terminalId);
      
      res.json({
        success: true,
        message: `Search index cleared for terminal ${terminalId}`,
        terminalId
      });
    } catch (error: any) {
      console.error('Clear terminal index error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getSearchStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = this.searchService.getIndexStats();
      
      res.json({
        indexStats: stats,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      console.error('Get search stats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getSearchHistory(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId, limit = 50 } = req.query;

      // This would typically retrieve search history from the search service
      // For now, return a placeholder response
      const history = {
        terminalId: terminalId || 'all',
        queries: [],
        total: 0,
        limit: parseInt(limit as string) || 50
      };

      res.json(history);
    } catch (error: any) {
      console.error('Get search history error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}