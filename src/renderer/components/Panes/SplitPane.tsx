import React, { useRef, useState, useCallback, useEffect } from 'react';
import './SplitPane.css';

interface SplitPaneProps {
  split: 'horizontal' | 'vertical';
  size: number; // percentage for first pane
  minSize?: number; // minimum percentage
  maxSize?: number; // maximum percentage
  onDragFinished?: (size: number) => void;
  // When set, one child is maximized: the indicated child fills 100% while the
  // OTHER stays MOUNTED but hidden and out of flow. null/undefined = normal split.
  // Only PROPS/CSS change here — both children keep the same positions and keys,
  // so their React subtrees (and the xterm instances inside) never remount.
  maximizedChild?: 0 | 1 | null;
  children: React.ReactNode[];
}

export const SplitPane: React.FC<SplitPaneProps> = ({
  split,
  size,
  minSize = 10,
  maxSize = 90,
  onDragFinished,
  maximizedChild = null,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [currentSize, setCurrentSize] = useState(size);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();

    let newSize: number;
    if (split === 'vertical') {
      const x = e.clientX - rect.left;
      newSize = (x / rect.width) * 100;
    } else {
      const y = e.clientY - rect.top;
      newSize = (y / rect.height) * 100;
    }

    newSize = Math.max(minSize, Math.min(maxSize, newSize));
    setCurrentSize(newSize);
  }, [isDragging, split, minSize, maxSize]);

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      onDragFinished?.(currentSize);
    }
  }, [isDragging, currentSize, onDragFinished]);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = split === 'vertical' ? 'col-resize' : 'row-resize';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp, split]);

  useEffect(() => {
    setCurrentSize(size);
  }, [size]);

  const isMaximizing = maximizedChild === 0 || maximizedChild === 1;

  // Maximized child: fills the whole container. Hidden sibling: kept mounted but
  // pulled out of flow (position:absolute) and made invisible/inert so the
  // maximized child gets 100%, while its PTY keeps running underneath.
  const fillStyle: React.CSSProperties = { width: '100%', height: '100%' };
  const hiddenStyle: React.CSSProperties = {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    width: '100%',
    height: '100%',
  };

  const pane1Style: React.CSSProperties = isMaximizing
    ? (maximizedChild === 0 ? fillStyle : hiddenStyle)
    : (split === 'vertical' ? { width: `${currentSize}%` } : { height: `${currentSize}%` });

  const pane2Style: React.CSSProperties = isMaximizing
    ? (maximizedChild === 1 ? fillStyle : hiddenStyle)
    : (split === 'vertical' ? { width: `${100 - currentSize}%` } : { height: `${100 - currentSize}%` });

  return (
    <div
      ref={containerRef}
      className={`split-pane ${split} ${isDragging ? 'dragging' : ''}`}
    >
      <div className="split-pane-1" style={pane1Style}>
        {children[0]}
      </div>
      {!isMaximizing && (
        <div
          className={`split-pane-divider ${split}`}
          onMouseDown={handleMouseDown}
        >
          <div className="split-pane-divider-inner" />
        </div>
      )}
      <div className="split-pane-2" style={pane2Style}>
        {children[1]}
      </div>
    </div>
  );
};