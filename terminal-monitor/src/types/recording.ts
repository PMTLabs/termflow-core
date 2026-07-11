export interface TerminalRecording {
  id: string;
  terminalId: string;
  startTime: Date;
  endTime?: Date;
  events: RecordingEvent[];
  metadata: RecordingMetadata;
  size: number; // bytes
  compressed: boolean;
}

export interface RecordingEvent {
  timestamp: number; // milliseconds since recording start
  type: 'output' | 'input' | 'resize' | 'clear' | 'title' | 'bell';
  data: any;
  size?: number; // bytes for this event
}

export interface RecordingMetadata {
  title?: string;
  description?: string;
  tags?: string[];
  shellType: string;
  initialSize: { cols: number; rows: number };
  terminalTitle?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  compressionRatio?: number;
}

export interface RecordingOptions {
  includeInput: boolean;
  includeOutput: boolean;
  includeResize: boolean;
  compression: 'none' | 'gzip' | 'lz4';
  maxDuration?: number; // seconds
  maxSize?: number; // bytes
  autoStop?: boolean;
}

export interface RecordingSession {
  recording: TerminalRecording;
  options: RecordingOptions;
  isActive: boolean;
  eventBuffer: RecordingEvent[];
  lastFlush: number;
}

export interface PlaybackState {
  recordingId: string;
  currentTime: number; // milliseconds
  duration: number; // milliseconds
  isPlaying: boolean;
  isPaused: boolean;
  speed: number; // playback speed multiplier
  loop: boolean;
  loopStart?: number;
  loopEnd?: number;
}

export interface PlaybackControls {
  play: () => void;
  pause: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setSpeed: (speed: number) => void;
  setLoop: (enabled: boolean, start?: number, end?: number) => void;
  skipToNext: () => void;
  skipToPrevious: () => void;
}

export interface RecordingExportOptions {
  format: 'json' | 'text' | 'html' | 'asciinema';
  includeMetadata: boolean;
  includeTimestamps: boolean;
  colorOutput: boolean;
  timeRange?: { start: number; end: number };
}

export interface StorageConfig {
  type: 'filesystem' | 'database' | 's3';
  path?: string; // for filesystem storage
  compression: 'gzip' | 'lz4' | 'none';
  retention: number; // days
  maxSize: number; // MB per recording
  maxTotal: number; // MB total storage
}

// Terminal Monitor specific types
export interface RecordingListItem {
  id: string;
  terminalId: string;
  startTime: string;
  endTime?: string;
  metadata: RecordingMetadata;
  size: number;
  compressed: boolean;
  eventCount: number;
  duration: number | null;
}

export interface RecordingResponse {
  recordings: RecordingListItem[];
  total: number;
  offset: number;
  limit: number;
}

export interface RecordingStatus {
  terminalId: string;
  isRecording: boolean;
  status: 'recording' | 'not_recording';
}

export interface StartRecordingRequest {
  terminalId: string;
  options?: Partial<RecordingOptions>;
}

export interface StartRecordingResponse {
  recordingId: string;
  terminalId: string;
  status: 'recording';
  startTime: string;
  options: RecordingOptions;
}

export interface StopRecordingResponse {
  recordingId: string;
  terminalId: string;
  status: 'stopped';
  startTime: Date;
  endTime: Date;
  eventCount: number;
  size: number;
  duration: number;
}