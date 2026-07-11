import { TerminalRecording, PlaybackState, PlaybackControls, RecordingEvent } from '../../types/recording';

export class PlaybackService implements PlaybackControls {
  private recording: TerminalRecording | null = null;
  private state: PlaybackState;
  private playbackTimer: NodeJS.Timeout | null = null;
  private onStateChange?: (state: PlaybackState) => void;
  private onDataUpdate?: (data: string) => void;
  private eventIndex = 0;

  constructor() {
    this.state = {
      recordingId: '',
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      isPaused: false,
      speed: 1.0,
      loop: false
    };
  }

  public loadRecording(recording: TerminalRecording): void {
    this.recording = recording;
    this.eventIndex = 0;
    
    // Calculate duration from last event
    const lastEvent = recording.events[recording.events.length - 1];
    const duration = lastEvent ? lastEvent.timestamp : 0;
    
    this.state = {
      recordingId: recording.id,
      currentTime: 0,
      duration,
      isPlaying: false,
      isPaused: false,
      speed: 1.0,
      loop: false
    };

    this.notifyStateChange();
  }

  public getState(): PlaybackState {
    return { ...this.state };
  }

  public setStateChangeCallback(callback: (state: PlaybackState) => void): void {
    this.onStateChange = callback;
  }

  public setDataUpdateCallback(callback: (data: string) => void): void {
    this.onDataUpdate = callback;
  }

  public play(): void {
    if (!this.recording) return;

    this.state.isPlaying = true;
    this.state.isPaused = false;
    this.notifyStateChange();

    this.startPlayback();
  }

  public pause(): void {
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.notifyStateChange();

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  public stop(): void {
    this.state.isPlaying = false;
    this.state.isPaused = false;
    this.state.currentTime = 0;
    this.eventIndex = 0;
    this.notifyStateChange();

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    // Clear terminal
    if (this.onDataUpdate) {
      this.onDataUpdate('\x1b[2J\x1b[H'); // Clear screen and home cursor
    }
  }

  public seek(time: number): void {
    if (!this.recording) return;

    this.state.currentTime = Math.max(0, Math.min(time, this.state.duration));
    
    // Find the event index for this time
    this.eventIndex = this.recording.events.findIndex(event => event.timestamp > this.state.currentTime);
    if (this.eventIndex === -1) {
      this.eventIndex = this.recording.events.length;
    }

    this.notifyStateChange();

    // Replay from beginning to current time to rebuild terminal state
    if (this.onDataUpdate) {
      this.replayToCurrentTime();
    }

    // Resume playback if it was playing
    if (this.state.isPlaying) {
      this.startPlayback();
    }
  }

  public setSpeed(speed: number): void {
    this.state.speed = Math.max(0.1, Math.min(speed, 4.0));
    this.notifyStateChange();

    // Restart playback with new speed if currently playing
    if (this.state.isPlaying) {
      if (this.playbackTimer) {
        clearTimeout(this.playbackTimer);
      }
      this.startPlayback();
    }
  }

  public setLoop(enabled: boolean, start?: number, end?: number): void {
    this.state.loop = enabled;
    this.state.loopStart = start;
    this.state.loopEnd = end;
    this.notifyStateChange();
  }

  public skipToNext(): void {
    if (!this.recording) return;

    // Find next significant event (output data)
    const currentIndex = this.eventIndex;
    let nextIndex = currentIndex;
    
    for (let i = currentIndex; i < this.recording.events.length; i++) {
      const event = this.recording.events[i];
      if (event.type === 'output' && event.data && event.data.length > 0) {
        nextIndex = i;
        break;
      }
    }

    if (nextIndex > currentIndex) {
      const nextEvent = this.recording.events[nextIndex];
      this.seek(nextEvent.timestamp);
    }
  }

  public skipToPrevious(): void {
    if (!this.recording) return;

    // Find previous significant event (output data)
    const currentIndex = this.eventIndex;
    let prevIndex = 0;
    
    for (let i = currentIndex - 1; i >= 0; i--) {
      const event = this.recording.events[i];
      if (event.type === 'output' && event.data && event.data.length > 0) {
        prevIndex = i;
        break;
      }
    }

    if (prevIndex < currentIndex) {
      const prevEvent = this.recording.events[prevIndex];
      this.seek(prevEvent.timestamp);
    }
  }

  private startPlayback(): void {
    if (!this.recording || this.eventIndex >= this.recording.events.length) {
      // End of recording
      if (this.state.loop) {
        // Loop back to start or loop start point
        this.seek(this.state.loopStart || 0);
        return;
      } else {
        this.stop();
        return;
      }
    }

    const event = this.recording.events[this.eventIndex];
    const nextEventTime = event.timestamp;
    const delay = (nextEventTime - this.state.currentTime) / this.state.speed;

    this.playbackTimer = setTimeout(() => {
      this.playEvent(event);
      this.state.currentTime = nextEventTime;
      this.eventIndex++;
      this.notifyStateChange();

      // Check loop end
      if (this.state.loop && this.state.loopEnd && this.state.currentTime >= this.state.loopEnd) {
        this.seek(this.state.loopStart || 0);
        return;
      }

      // Continue playback
      if (this.state.isPlaying) {
        this.startPlayback();
      }
    }, delay);
  }

  private playEvent(event: RecordingEvent): void {
    if (!this.onDataUpdate) return;

    switch (event.type) {
      case 'output':
        this.onDataUpdate(event.data);
        break;
      case 'clear':
        this.onDataUpdate('\x1b[2J\x1b[H'); // Clear screen
        break;
      case 'bell':
        // Browser bell (could trigger notification)
        if (window && window.navigator && window.navigator.vibrate) {
          window.navigator.vibrate(100);
        }
        break;
      // Input events are typically not replayed during playback
      // Resize events would need terminal resizing which is complex
    }
  }

  private replayToCurrentTime(): void {
    if (!this.recording || !this.onDataUpdate) return;

    // Clear terminal first
    this.onDataUpdate('\x1b[2J\x1b[H');

    // Replay all events up to current time
    for (const event of this.recording.events) {
      if (event.timestamp <= this.state.currentTime) {
        this.playEvent(event);
      } else {
        break;
      }
    }
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }

  public cleanup(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.state.isPlaying = false;
    this.state.isPaused = false;
  }
}