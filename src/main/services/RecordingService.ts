import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { 
  TerminalRecording, 
  RecordingEvent, 
  RecordingOptions, 
  RecordingSession,
  RecordingMetadata,
  StorageConfig 
} from '../../types/recording';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class RecordingService extends EventEmitter {
  private activeSessions = new Map<string, RecordingSession>();
  private storageConfig: StorageConfig;
  private recordingsDir: string;
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(config: StorageConfig) {
    super();
    this.storageConfig = config;
    this.recordingsDir = config.path || path.join(process.cwd(), 'recordings');
    this.setupStorage();
    this.startFlushTimer();
  }

  private async setupStorage(): Promise<void> {
    try {
      await fs.mkdir(this.recordingsDir, { recursive: true });
    } catch (error) {
      console.error('Failed to setup recordings directory:', error);
    }
  }

  private startFlushTimer(): void {
    // Flush event buffers every 5 seconds
    this.flushInterval = setInterval(() => {
      this.flushAllBuffers();
    }, 5000);
  }

  async startRecording(
    terminalId: string, 
    options: Partial<RecordingOptions> = {}
  ): Promise<string> {
    const recordingId = uuidv4();
    const now = new Date();

    const defaultOptions: RecordingOptions = {
      includeInput: true,
      includeOutput: true,
      includeResize: true,
      compression: this.storageConfig.compression,
      autoStop: false,
      ...options
    };

    const metadata: RecordingMetadata = {
      shellType: 'unknown', // Will be populated by terminal info
      initialSize: { cols: 80, rows: 24 }, // Will be updated
      tags: []
    };

    const recording: TerminalRecording = {
      id: recordingId,
      terminalId,
      startTime: now,
      events: [],
      metadata,
      size: 0,
      compressed: defaultOptions.compression !== 'none'
    };

    const session: RecordingSession = {
      recording,
      options: defaultOptions,
      isActive: true,
      eventBuffer: [],
      lastFlush: Date.now()
    };

    this.activeSessions.set(recordingId, session);

    // Set auto-stop timer if specified
    if (defaultOptions.maxDuration) {
      setTimeout(() => {
        if (defaultOptions.autoStop) {
          this.stopRecording(recordingId);
        }
      }, defaultOptions.maxDuration * 1000);
    }

    this.emit('recordingStarted', { recordingId, terminalId });
    return recordingId;
  }

  async stopRecording(recordingId: string): Promise<TerminalRecording | null> {
    const session = this.activeSessions.get(recordingId);
    if (!session || !session.isActive) {
      return null;
    }

    session.isActive = false;
    session.recording.endTime = new Date();

    // Flush remaining events
    await this.flushBuffer(recordingId);

    // Save to storage
    await this.saveRecording(session.recording);

    this.activeSessions.delete(recordingId);
    this.emit('recordingStopped', { recordingId });

    return session.recording;
  }

  recordEvent(terminalId: string, event: Omit<RecordingEvent, 'timestamp'>): void {
    // Find active recording for this terminal
    const session = Array.from(this.activeSessions.values())
      .find(s => s.recording.terminalId === terminalId && s.isActive);

    if (!session) {
      return;
    }

    // Check if this event type should be recorded
    if (event.type === 'input' && !session.options.includeInput) return;
    if (event.type === 'output' && !session.options.includeOutput) return;
    if (event.type === 'resize' && !session.options.includeResize) return;

    const timestamp = Date.now() - session.recording.startTime.getTime();
    const recordingEvent: RecordingEvent = {
      ...event,
      timestamp,
      size: this.calculateEventSize(event.data)
    };

    session.eventBuffer.push(recordingEvent);
    session.recording.size += recordingEvent.size || 0;

    // Check size limits
    if (session.options.maxSize && session.recording.size > session.options.maxSize) {
      this.stopRecording(session.recording.id);
    }

    // Flush buffer if it gets too large (1000 events)
    if (session.eventBuffer.length >= 1000) {
      this.flushBuffer(session.recording.id);
    }
  }

  private calculateEventSize(data: any): number {
    if (typeof data === 'string') {
      return Buffer.byteLength(data, 'utf8');
    }
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  }

  private async flushAllBuffers(): Promise<void> {
    const flushPromises = Array.from(this.activeSessions.keys())
      .map(recordingId => this.flushBuffer(recordingId));
    
    await Promise.all(flushPromises);
  }

  private async flushBuffer(recordingId: string): Promise<void> {
    const session = this.activeSessions.get(recordingId);
    if (!session || session.eventBuffer.length === 0) {
      return;
    }

    // Move events from buffer to recording
    session.recording.events.push(...session.eventBuffer);
    session.eventBuffer = [];
    session.lastFlush = Date.now();
  }

  private async saveRecording(recording: TerminalRecording): Promise<void> {
    const filename = `${recording.id}.json`;
    const filepath = path.join(this.recordingsDir, filename);

    let data = JSON.stringify(recording, null, 2);

    // Apply compression if enabled
    if (recording.compressed && this.storageConfig.compression === 'gzip') {
      const compressed = await gzip(Buffer.from(data, 'utf8'));
      await fs.writeFile(filepath + '.gz', compressed);
      
      // Calculate compression ratio
      recording.metadata.compressionRatio = compressed.length / Buffer.byteLength(data, 'utf8');
    } else {
      await fs.writeFile(filepath, data, 'utf8');
    }
  }

  async loadRecording(recordingId: string): Promise<TerminalRecording | null> {
    const filename = `${recordingId}.json`;
    const filepath = path.join(this.recordingsDir, filename);
    const compressedPath = filepath + '.gz';

    try {
      // Try compressed file first
      if (await this.fileExists(compressedPath)) {
        const compressed = await fs.readFile(compressedPath);
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString('utf8'));
      }

      // Try uncompressed file
      if (await this.fileExists(filepath)) {
        const data = await fs.readFile(filepath, 'utf8');
        return JSON.parse(data);
      }

      return null;
    } catch (error) {
      console.error('Failed to load recording:', error);
      return null;
    }
  }

  async listRecordings(): Promise<TerminalRecording[]> {
    try {
      const files = await fs.readdir(this.recordingsDir);
      const recordingFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));
      
      const recordings: TerminalRecording[] = [];
      
      for (const file of recordingFiles) {
        const recordingId = file.replace(/\.json(\.gz)?$/, '');
        const recording = await this.loadRecording(recordingId);
        if (recording) {
          recordings.push(recording);
        }
      }

      // Sort by start time, newest first
      return recordings.sort((a, b) => 
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
      );
    } catch (error) {
      console.error('Failed to list recordings:', error);
      return [];
    }
  }

  async deleteRecording(recordingId: string): Promise<boolean> {
    const filename = `${recordingId}.json`;
    const filepath = path.join(this.recordingsDir, filename);
    const compressedPath = filepath + '.gz';

    try {
      if (await this.fileExists(compressedPath)) {
        await fs.unlink(compressedPath);
      } else if (await this.fileExists(filepath)) {
        await fs.unlink(filepath);
      } else {
        return false;
      }

      this.emit('recordingDeleted', { recordingId });
      return true;
    } catch (error) {
      console.error('Failed to delete recording:', error);
      return false;
    }
  }

  async getRecordingInfo(recordingId: string): Promise<Partial<TerminalRecording> | null> {
    const recording = await this.loadRecording(recordingId);
    if (!recording) {
      return null;
    }

    // Return metadata without the full events array for performance
    return {
      id: recording.id,
      terminalId: recording.terminalId,
      startTime: recording.startTime,
      endTime: recording.endTime,
      metadata: recording.metadata,
      size: recording.size,
      compressed: recording.compressed
    };
  }

  getActiveRecordings(): string[] {
    return Array.from(this.activeSessions.keys())
      .filter(id => this.activeSessions.get(id)?.isActive);
  }

  isRecording(terminalId: string): boolean {
    return Array.from(this.activeSessions.values())
      .some(session => session.recording.terminalId === terminalId && session.isActive);
  }

  private async fileExists(filepath: string): Promise<boolean> {
    try {
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    // Stop flush timer
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    // Stop all active recordings
    const activeIds = Array.from(this.activeSessions.keys());
    await Promise.all(activeIds.map(id => this.stopRecording(id)));

    // Clean up old recordings based on retention policy
    await this.cleanupOldRecordings();
  }

  private async cleanupOldRecordings(): Promise<void> {
    const recordings = await this.listRecordings();
    const retentionMs = this.storageConfig.retention * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    for (const recording of recordings) {
      const recordingTime = new Date(recording.startTime).getTime();
      if (recordingTime < cutoffTime) {
        await this.deleteRecording(recording.id);
      }
    }
  }
}