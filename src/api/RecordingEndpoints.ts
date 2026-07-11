import { Request, Response } from 'express';
import { RecordingService } from '../main/services/RecordingService';
import { RecordingOptions, RecordingExportOptions } from '../types/recording';
import { authMiddleware, Permissions } from './auth';
// import * as fs from 'fs/promises';
// import * as path from 'path';

export class RecordingEndpoints {
  constructor(private recordingService: RecordingService) {}

  public setupRoutes(app: any, authManager: any): void {
    const auth = authMiddleware.bind(null, authManager);

    // Recording management
    app.post('/api/recordings/start', 
      auth(Permissions.TERMINAL_WRITE), 
      this.startRecording.bind(this)
    );
    
    app.post('/api/recordings/stop/:id', 
      auth(Permissions.TERMINAL_WRITE), 
      this.stopRecording.bind(this)
    );
    
    app.get('/api/recordings', 
      auth(Permissions.TERMINAL_READ), 
      this.listRecordings.bind(this)
    );
    
    app.get('/api/recordings/:id', 
      auth(Permissions.TERMINAL_READ), 
      this.getRecording.bind(this)
    );

    app.get('/api/recordings/:id/info', 
      auth(Permissions.TERMINAL_READ), 
      this.getRecordingInfo.bind(this)
    );
    
    app.delete('/api/recordings/:id', 
      auth(Permissions.TERMINAL_DELETE), 
      this.deleteRecording.bind(this)
    );

    // Recording export
    app.post('/api/recordings/:id/export', 
      auth(Permissions.TERMINAL_READ), 
      this.exportRecording.bind(this)
    );

    // Recording status
    app.get('/api/recordings/status/:terminalId', 
      auth(Permissions.TERMINAL_READ), 
      this.getRecordingStatus.bind(this)
    );

    // Active recordings
    app.get('/api/recordings/active', 
      auth(Permissions.TERMINAL_READ), 
      this.getActiveRecordings.bind(this)
    );
  }

  private async startRecording(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId, options } = req.body;

      if (!terminalId || typeof terminalId !== 'string') {
        res.status(400).json({ error: 'Terminal ID is required' });
        return;
      }

      // Check if terminal is already being recorded
      if (this.recordingService.isRecording(terminalId)) {
        res.status(409).json({ error: 'Terminal is already being recorded' });
        return;
      }

      const recordingOptions: Partial<RecordingOptions> = {
        includeInput: true,
        includeOutput: true,
        includeResize: true,
        compression: 'gzip',
        autoStop: false,
        ...options
      };

      const recordingId = await this.recordingService.startRecording(terminalId, recordingOptions);

      res.status(201).json({
        recordingId,
        terminalId,
        status: 'recording',
        startTime: new Date().toISOString(),
        options: recordingOptions
      });
    } catch (error: any) {
      console.error('Error starting recording:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async stopRecording(req: Request, res: Response): Promise<void> {
    try {
      const { id: recordingId } = req.params;

      const recording = await this.recordingService.stopRecording(recordingId);
      
      if (!recording) {
        res.status(404).json({ error: 'Recording not found or not active' });
        return;
      }

      res.json({
        recordingId: recording.id,
        terminalId: recording.terminalId,
        status: 'stopped',
        startTime: recording.startTime,
        endTime: recording.endTime,
        eventCount: recording.events.length,
        size: recording.size,
        duration: recording.endTime 
          ? new Date(recording.endTime).getTime() - new Date(recording.startTime).getTime()
          : 0
      });
    } catch (error: any) {
      console.error('Error stopping recording:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async listRecordings(req: Request, res: Response): Promise<void> {
    try {
      const { limit, offset, terminalId } = req.query;
      
      let recordings = await this.recordingService.listRecordings();

      // Filter by terminal if specified
      if (terminalId) {
        recordings = recordings.filter(r => r.terminalId === terminalId);
      }

      // Apply pagination
      const offsetNum = parseInt(offset as string) || 0;
      const limitNum = parseInt(limit as string) || 100;
      
      const paginatedRecordings = recordings.slice(offsetNum, offsetNum + limitNum);

      // Transform for API response (exclude full events array for performance)
      const recordingList = paginatedRecordings.map(recording => ({
        id: recording.id,
        terminalId: recording.terminalId,
        startTime: recording.startTime,
        endTime: recording.endTime,
        metadata: recording.metadata,
        size: recording.size,
        compressed: recording.compressed,
        eventCount: recording.events.length,
        duration: recording.endTime 
          ? new Date(recording.endTime).getTime() - new Date(recording.startTime).getTime()
          : null
      }));

      res.json({
        recordings: recordingList,
        total: recordings.length,
        offset: offsetNum,
        limit: limitNum
      });
    } catch (error: any) {
      console.error('Error listing recordings:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getRecording(req: Request, res: Response): Promise<void> {
    try {
      const { id: recordingId } = req.params;
      const { includeEvents } = req.query;

      const recording = await this.recordingService.loadRecording(recordingId);
      
      if (!recording) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }

      // Optionally exclude events for performance
      if (includeEvents !== 'true') {
        const { events, ...recordingWithoutEvents } = recording;
        res.json({
          ...recordingWithoutEvents,
          eventCount: events.length
        });
      } else {
        res.json(recording);
      }
    } catch (error: any) {
      console.error('Error getting recording:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getRecordingInfo(req: Request, res: Response): Promise<void> {
    try {
      const { id: recordingId } = req.params;

      const info = await this.recordingService.getRecordingInfo(recordingId);
      
      if (!info) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }

      res.json(info);
    } catch (error: any) {
      console.error('Error getting recording info:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async deleteRecording(req: Request, res: Response): Promise<void> {
    try {
      const { id: recordingId } = req.params;

      const success = await this.recordingService.deleteRecording(recordingId);
      
      if (!success) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }

      res.status(204).send();
    } catch (error: any) {
      console.error('Error deleting recording:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async exportRecording(req: Request, res: Response): Promise<void> {
    try {
      const { id: recordingId } = req.params;
      const exportOptions: RecordingExportOptions = {
        format: 'json',
        includeMetadata: true,
        includeTimestamps: true,
        colorOutput: true,
        ...req.body
      };

      const recording = await this.recordingService.loadRecording(recordingId);
      
      if (!recording) {
        res.status(404).json({ error: 'Recording not found' });
        return;
      }

      let exportData: any;
      let contentType: string;
      let filename: string;

      switch (exportOptions.format) {
        case 'json':
          exportData = this.exportAsJson(recording, exportOptions);
          contentType = 'application/json';
          filename = `recording-${recordingId}.json`;
          break;
        
        case 'text':
          exportData = this.exportAsText(recording, exportOptions);
          contentType = 'text/plain';
          filename = `recording-${recordingId}.txt`;
          break;
        
        case 'html':
          exportData = this.exportAsHtml(recording, exportOptions);
          contentType = 'text/html';
          filename = `recording-${recordingId}.html`;
          break;
        
        case 'asciinema':
          exportData = this.exportAsAsciinema(recording, exportOptions);
          contentType = 'application/json';
          filename = `recording-${recordingId}.cast`;
          break;
        
        default:
          res.status(400).json({ error: 'Unsupported export format' });
          return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      if (typeof exportData === 'string') {
        res.send(exportData);
      } else {
        res.json(exportData);
      }
    } catch (error: any) {
      console.error('Error exporting recording:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getRecordingStatus(req: Request, res: Response): Promise<void> {
    try {
      const { terminalId } = req.params;

      const isRecording = this.recordingService.isRecording(terminalId);
      
      res.json({
        terminalId,
        isRecording,
        status: isRecording ? 'recording' : 'not_recording'
      });
    } catch (error: any) {
      console.error('Error getting recording status:', error);
      res.status(500).json({ error: error.message });
    }
  }

  private async getActiveRecordings(_req: Request, res: Response): Promise<void> {
    try {
      const activeRecordingIds = this.recordingService.getActiveRecordings();
      
      res.json({
        activeRecordings: activeRecordingIds,
        count: activeRecordingIds.length
      });
    } catch (error: any) {
      console.error('Error getting active recordings:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Export format implementations
  private exportAsJson(recording: any, options: RecordingExportOptions): any {
    let events = recording.events;
    
    // Apply time range filter if specified
    if (options.timeRange) {
      events = events.filter((event: any) => 
        event.timestamp >= options.timeRange!.start && 
        event.timestamp <= options.timeRange!.end
      );
    }

    const exportData: any = {
      events
    };

    if (options.includeMetadata) {
      exportData.metadata = recording.metadata;
      exportData.id = recording.id;
      exportData.terminalId = recording.terminalId;
      exportData.startTime = recording.startTime;
      exportData.endTime = recording.endTime;
    }

    return exportData;
  }

  private exportAsText(recording: any, options: RecordingExportOptions): string {
    let events = recording.events.filter((e: any) => e.type === 'output');
    
    // Apply time range filter if specified
    if (options.timeRange) {
      events = events.filter((event: any) => 
        event.timestamp >= options.timeRange!.start && 
        event.timestamp <= options.timeRange!.end
      );
    }

    let output = '';
    
    if (options.includeMetadata) {
      output += `# Recording: ${recording.id}\n`;
      output += `# Terminal: ${recording.terminalId}\n`;
      output += `# Start: ${recording.startTime}\n`;
      output += `# End: ${recording.endTime}\n`;
      output += `# Events: ${events.length}\n\n`;
    }

    for (const event of events) {
      if (options.includeTimestamps) {
        output += `[${event.timestamp}ms] `;
      }
      output += event.data;
    }

    return output;
  }

  private exportAsHtml(recording: any, options: RecordingExportOptions): string {
    let events = recording.events.filter((e: any) => e.type === 'output');
    
    // Apply time range filter if specified
    if (options.timeRange) {
      events = events.filter((event: any) => 
        event.timestamp >= options.timeRange!.start && 
        event.timestamp <= options.timeRange!.end
      );
    }

    let html = `<!DOCTYPE html>
<html>
<head>
    <title>Terminal Recording ${recording.id}</title>
    <style>
        body { font-family: 'Courier New', monospace; background: #000; color: #fff; padding: 20px; }
        .metadata { color: #888; margin-bottom: 20px; }
        .terminal { background: #000; border: 1px solid #333; padding: 10px; }
        .timestamp { color: #666; }
        pre { margin: 0; white-space: pre-wrap; }
    </style>
</head>
<body>`;

    if (options.includeMetadata) {
      html += `<div class="metadata">
        <h3>Recording Information</h3>
        <p>ID: ${recording.id}</p>
        <p>Terminal: ${recording.terminalId}</p>
        <p>Start: ${recording.startTime}</p>
        <p>End: ${recording.endTime}</p>
        <p>Events: ${events.length}</p>
      </div>`;
    }

    html += '<div class="terminal"><pre>';
    
    for (const event of events) {
      if (options.includeTimestamps) {
        html += `<span class="timestamp">[${event.timestamp}ms]</span> `;
      }
      // Escape HTML and preserve formatting
      const escapedData = event.data
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      html += escapedData;
    }

    html += '</pre></div></body></html>';
    return html;
  }

  private exportAsAsciinema(recording: any, options: RecordingExportOptions): any {
    // Convert to asciinema v2 format
    const header = {
      version: 2,
      width: recording.metadata.initialSize.cols,
      height: recording.metadata.initialSize.rows,
      timestamp: Math.floor(new Date(recording.startTime).getTime() / 1000),
      title: recording.metadata.title || `Recording ${recording.id}`,
      env: {
        SHELL: recording.metadata.shellType || '/bin/bash',
        TERM: 'xterm-256color'
      }
    };

    let events = recording.events;
    
    // Apply time range filter if specified
    if (options.timeRange) {
      events = events.filter((event: any) => 
        event.timestamp >= options.timeRange!.start && 
        event.timestamp <= options.timeRange!.end
      );
    }

    const lines = [JSON.stringify(header)];
    
    for (const event of events) {
      if (event.type === 'output') {
        const asciinemaEvent = [
          event.timestamp / 1000, // Convert to seconds
          'o', // output
          event.data
        ];
        lines.push(JSON.stringify(asciinemaEvent));
      } else if (event.type === 'input' && options.includeTimestamps) {
        const asciinemaEvent = [
          event.timestamp / 1000,
          'i', // input
          event.data
        ];
        lines.push(JSON.stringify(asciinemaEvent));
      }
    }

    return lines.join('\n');
  }
}