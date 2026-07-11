import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { PlaybackService } from '../../services/PlaybackService';
import { PlaybackControls } from './PlaybackControls';
import { TerminalRecording, PlaybackState } from '../../../types/recording';
import './PlaybackViewer.css';

interface PlaybackViewerProps {
  recording: TerminalRecording;
  onClose: () => void;
}

export const PlaybackViewer: React.FC<PlaybackViewerProps> = ({ recording, onClose }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [_terminal, setTerminal] = useState<Terminal | null>(null);
  const [playbackService, setPlaybackService] = useState<PlaybackService | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    recordingId: '',
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    isPaused: false,
    speed: 1.0,
    loop: false
  });

  // Initialize terminal and playback service
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const term = new Terminal({
      theme: {
        background: '#000000',
        foreground: '#ffffff',
        cursor: '#ffffff',
        cursorAccent: '#000000',
        selectionBackground: '#ffffff40'
      },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      rows: recording.metadata.initialSize.rows,
      cols: recording.metadata.initialSize.cols,
      convertEol: true,
      disableStdin: true // Disable input for playback
    });

    // Add addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    // Open terminal
    term.open(terminalRef.current);
    fitAddon.fit();

    // Create playback service
    const service = new PlaybackService();
    service.loadRecording(recording);
    
    // Set up callbacks
    service.setStateChangeCallback(setPlaybackState);
    service.setDataUpdateCallback((data: string) => {
      term.write(data);
    });

    setTerminal(term);
    setPlaybackService(service);

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      service.cleanup();
      term.dispose();
    };
  }, [recording]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!playbackService) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (playbackState.isPlaying) {
            playbackService.pause();
          } else {
            playbackService.play();
          }
          break;
        case 'Escape':
          e.preventDefault();
          playbackService.stop();
          break;
        case 'ArrowLeft':
          if (e.shiftKey) {
            e.preventDefault();
            playbackService.skipToPrevious();
          }
          break;
        case 'ArrowRight':
          if (e.shiftKey) {
            e.preventDefault();
            playbackService.skipToNext();
          }
          break;
        case 'Home':
          e.preventDefault();
          playbackService.seek(0);
          break;
        case 'End':
          e.preventDefault();
          playbackService.seek(playbackState.duration);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [playbackService, playbackState]);

  if (!playbackService) {
    return <div className="playback-loading">Loading recording...</div>;
  }

  return (
    <div className="playback-viewer">
      <div className="playback-header">
        <div className="recording-info">
          <h3>{recording.metadata.title || `Recording ${recording.id.substring(0, 8)}`}</h3>
          <div className="recording-meta">
            <span>Terminal: {recording.terminalId}</span>
            <span>Duration: {Math.floor(playbackState.duration / 1000)}s</span>
            <span>Events: {recording.events.length}</span>
            <span>Size: {(recording.size / 1024).toFixed(1)} KB</span>
          </div>
        </div>
        <div className="playback-actions">
          <button className="close-button" onClick={onClose} title="Close Playback">
            ✕
          </button>
        </div>
      </div>

      <div className="terminal-container">
        <div ref={terminalRef} className="terminal-display" />
      </div>

      <PlaybackControls
        state={playbackState}
        onPlay={() => playbackService.play()}
        onPause={() => playbackService.pause()}
        onStop={() => playbackService.stop()}
        onSeek={(time) => playbackService.seek(time)}
        onSpeedChange={(speed) => playbackService.setSpeed(speed)}
        onLoop={(enabled) => playbackService.setLoop(enabled)}
        onSkipNext={() => playbackService.skipToNext()}
        onSkipPrevious={() => playbackService.skipToPrevious()}
      />

      <div className="keyboard-shortcuts">
        <div className="shortcuts-info">
          <span><kbd>Space</kbd> Play/Pause</span>
          <span><kbd>Esc</kbd> Stop</span>
          <span><kbd>Shift+←</kbd> Previous</span>
          <span><kbd>Shift+→</kbd> Next</span>
          <span><kbd>Home</kbd> Start</span>
          <span><kbd>End</kbd> End</span>
        </div>
      </div>
    </div>
  );
};