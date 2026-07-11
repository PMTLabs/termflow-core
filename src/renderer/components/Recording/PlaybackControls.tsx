import React, { useState, useRef } from 'react';
import { PlaybackState } from '../../../types/recording';
import './PlaybackControls.css';

interface PlaybackControlsProps {
  state: PlaybackState;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (time: number) => void;
  onSpeedChange: (speed: number) => void;
  onLoop: (enabled: boolean) => void;
  onSkipNext: () => void;
  onSkipPrevious: () => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

export const PlaybackControls: React.FC<PlaybackControlsProps> = ({
  state,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onSpeedChange,
  onLoop,
  onSkipNext,
  onSkipPrevious
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const progressRef = useRef<HTMLDivElement>(null);

  const formatTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const handleProgressClick = (e: React.MouseEvent) => {
    if (!progressRef.current) return;
    
    const rect = progressRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const progressWidth = rect.width;
    const clickRatio = clickX / progressWidth;
    const newTime = clickRatio * state.duration;
    
    onSeek(newTime);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    handleProgressClick(e);
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!progressRef.current) return;
      
      const rect = progressRef.current.getBoundingClientRect();
      const moveX = e.clientX - rect.left;
      const progressWidth = rect.width;
      const moveRatio = Math.max(0, Math.min(1, moveX / progressWidth));
      const newTime = moveRatio * state.duration;
      
      setDragTime(newTime);
    };
    
    const handleMouseUp = () => {
      setIsDragging(false);
      onSeek(dragTime);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const currentTime = isDragging ? dragTime : state.currentTime;
  const progressPercent = state.duration > 0 ? (currentTime / state.duration) * 100 : 0;

  return (
    <div className="playback-controls">
      <div className="playback-buttons">
        <button 
          onClick={onSkipPrevious}
          className="control-button"
          title="Skip to Previous"
        >
          ⏮
        </button>
        
        {state.isPlaying ? (
          <button 
            onClick={onPause}
            className="control-button play-pause"
            title="Pause"
          >
            ⏸
          </button>
        ) : (
          <button 
            onClick={onPlay}
            className="control-button play-pause"
            title="Play"
          >
            ▶
          </button>
        )}
        
        <button 
          onClick={onStop}
          className="control-button"
          title="Stop"
        >
          ⏹
        </button>
        
        <button 
          onClick={onSkipNext}
          className="control-button"
          title="Skip to Next"
        >
          ⏭
        </button>
      </div>

      <div className="progress-section">
        <div className="time-display">
          {formatTime(currentTime)}
        </div>
        
        <div 
          className="progress-container"
          ref={progressRef}
          onClick={handleProgressClick}
          onMouseDown={handleMouseDown}
        >
          <div className="progress-track">
            <div 
              className="progress-bar"
              style={{ width: `${progressPercent}%` }}
            />
            <div 
              className="progress-thumb"
              style={{ left: `${progressPercent}%` }}
            />
          </div>
          
          {state.loopStart !== undefined && state.loopEnd !== undefined && (
            <>
              <div 
                className="loop-marker loop-start"
                style={{ left: `${(state.loopStart / state.duration) * 100}%` }}
              />
              <div 
                className="loop-marker loop-end"
                style={{ left: `${(state.loopEnd / state.duration) * 100}%` }}
              />
            </>
          )}
        </div>
        
        <div className="time-display">
          {formatTime(state.duration)}
        </div>
      </div>

      <div className="playback-options">
        <div className="speed-control">
          <label>Speed:</label>
          <select 
            value={state.speed} 
            onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
            className="speed-select"
          >
            {SPEED_OPTIONS.map(speed => (
              <option key={speed} value={speed}>
                {speed}x
              </option>
            ))}
          </select>
        </div>
        
        <label className="loop-control">
          <input 
            type="checkbox" 
            checked={state.loop}
            onChange={(e) => onLoop(e.target.checked)}
          />
          Loop
        </label>
      </div>
    </div>
  );
};