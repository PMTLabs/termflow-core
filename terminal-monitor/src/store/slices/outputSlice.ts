// NOTE (terminal-core phase-4): This slice is retained but no longer fed at
// runtime. Live terminal output now renders directly via the terminal-core
// engine (WebSocketService `onOutput` seam → xterm), so WebSocketService no
// longer dispatches `appendOutput`. No production component reads
// `selectTerminalOutput`. The slice (and its `setOutput`/`clearOutput`/
// `removeTerminalBuffer` actions + selector) is kept inert rather than deleted
// to avoid churning the (currently non-runnable) monitor jest suite and the
// GridLayout/integration test stores that still reference `outputReducer`.
// It can be removed once those tests are updated. See docs/auto-terminal/changelogs.md.
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface OutputChunk {
  data: string;
  timestamp: number;
}

interface OutputBuffer {
  chunks: OutputChunk[];
  fullText?: string; // Cached concatenated version
  lastCacheTime: number;
  source: 'api' | 'websocket' | 'none'; // Track content source to avoid mixing
}

interface OutputBuffers {
  [terminalId: string]: OutputBuffer;
}

interface OutputState {
  buffers: OutputBuffers;
  maxBufferSize: number;
  maxChunks: number;
  cacheThreshold: number; // Min time between cache rebuilds (ms)
}

const initialState: OutputState = {
  buffers: {},
  maxBufferSize: 2000000, // Max characters per terminal (2MB) - increased for high-frequency messages
  maxChunks: 500, // Reduced chunks before consolidation for better memory management
  cacheThreshold: 16, // ~60fps cache threshold for smooth updates
};

// Helper functions for optimized buffer management
const getFullText = (buffer: OutputBuffer): string => {
  const now = Date.now();

  // Return cached version if recent
  if (buffer.fullText !== undefined && (now - buffer.lastCacheTime) < 16) {
    return buffer.fullText;
  }

  // Rebuild cache efficiently - don't mutate in selector, just calculate
  // Use Array.join for optimal string concatenation performance
  return buffer.chunks.map(chunk => chunk.data).join('');
};

const consolidateChunks = (buffer: OutputBuffer, maxSize: number): void => {
  if (buffer.chunks.length <= 5) return; // More aggressive consolidation for high-frequency messages

  const fullText = getFullText(buffer);

  // More intelligent trimming - keep recent content
  let trimmedText = fullText;
  if (fullText.length > maxSize) {
    // Keep the last 85% of content to preserve recent output
    const keepSize = Math.floor(maxSize * 0.85);
    trimmedText = fullText.slice(-keepSize);

    // Try to trim at line boundaries for better readability
    const lastNewline = trimmedText.indexOf('\n');
    if (lastNewline > -1 && lastNewline < trimmedText.length * 0.1) {
      trimmedText = trimmedText.slice(lastNewline + 1);
    }
  }

  // Replace chunks with single consolidated chunk
  buffer.chunks = [{
    data: trimmedText,
    timestamp: Date.now()
  }];
  buffer.fullText = trimmedText;
  buffer.lastCacheTime = Date.now();
};

const addChunk = (buffer: OutputBuffer, data: string, maxChunks: number, maxSize: number): void => {
  // For high-frequency updates, merge with the last chunk if it's very recent
  const now = Date.now();
  const lastChunk = buffer.chunks[buffer.chunks.length - 1];

  if (lastChunk && (now - lastChunk.timestamp) < 10) { // Merge if within 10ms
    lastChunk.data += data;
    lastChunk.timestamp = now;
  } else {
    buffer.chunks.push({
      data,
      timestamp: now
    });
  }

  // Invalidate cache
  buffer.fullText = undefined;

  // More aggressive consolidation for high-frequency messages
  if (buffer.chunks.length > maxChunks ||
    (buffer.chunks.length > 50 && buffer.chunks.reduce((acc, chunk) => acc + chunk.data.length, 0) > maxSize * 0.8)) {
    consolidateChunks(buffer, maxSize);
  }
};

const outputSlice = createSlice({
  name: 'output',
  initialState,
  reducers: {
    appendOutput: (
      state,
      action: PayloadAction<{ terminalId: string; data: string }>
    ) => {
      const { terminalId, data } = action.payload;

      if (!state.buffers[terminalId]) {
        state.buffers[terminalId] = { chunks: [], lastCacheTime: 0, source: 'none' };
      }

      const buffer = state.buffers[terminalId];

      // Switch source to websocket but KEEP existing content
      // API content is already processed (cursor-stripped) and forms a valid base
      // for continuing with live WebSocket data
      if (buffer.source === 'api') {
        console.log(`[outputSlice] Switching terminal ${terminalId} from API to WebSocket mode (preserving ${buffer.chunks.length} chunks)`);
      }
      buffer.source = 'websocket';

      // Simple append - let xterm.js handle escape sequences
      addChunk(buffer, data, state.maxChunks, state.maxBufferSize);
    },
    setOutput: (
      state,
      action: PayloadAction<{ terminalId: string; data: string }>
    ) => {
      const { terminalId, data } = action.payload;

      // Don't overwrite WebSocket content with API content
      // WebSocket provides live, unstripped data; API provides historical, stripped data
      // Mixing them causes duplicate prompts and cursor positioning issues
      const existingBuffer = state.buffers[terminalId];
      if (existingBuffer?.source === 'websocket' && existingBuffer.chunks.length > 0) {
        console.log(`[outputSlice] Ignoring API setOutput for terminal ${terminalId}, already has WebSocket data`);
        return;
      }

      // Replace entire buffer with new data (from API)
      state.buffers[terminalId] = {
        chunks: [{
          data: data.length > state.maxBufferSize
            ? data.slice(-state.maxBufferSize)
            : data,
          timestamp: Date.now()
        }],
        fullText: data.length > state.maxBufferSize
          ? data.slice(-state.maxBufferSize)
          : data,
        lastCacheTime: Date.now(),
        source: 'api' // Mark as API content (historical, stripped)
      };
    },
    clearOutput: (state, action: PayloadAction<string>) => {
      const terminalId = action.payload;
      if (state.buffers[terminalId]) {
        state.buffers[terminalId] = {
          chunks: [],
          lastCacheTime: Date.now(),
          source: 'none' // Reset source on clear
        };
      }
    },
    removeTerminalBuffer: (state, action: PayloadAction<string>) => {
      const terminalId = action.payload;
      delete state.buffers[terminalId];
    },
  },
});

export const { appendOutput, setOutput, clearOutput, removeTerminalBuffer } =
  outputSlice.actions;

// Selector to efficiently get terminal output text
export const selectTerminalOutput = (state: { output: OutputState }, terminalId: string): string => {
  const buffer = state.output.buffers[terminalId];
  if (!buffer || buffer.chunks.length === 0) {
    return '';
  }
  return getFullText(buffer);
};

export default outputSlice.reducer;
