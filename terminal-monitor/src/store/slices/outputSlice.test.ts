import outputReducer, {
  appendOutput,
  setOutput,
  clearOutput,
  removeTerminalBuffer,
  selectTerminalOutput,
} from './outputSlice';

// Use the actual interfaces from the slice
interface OutputChunk {
  data: string;
  timestamp: number;
}

interface OutputBuffer {
  chunks: OutputChunk[];
  fullText?: string;
  lastCacheTime: number;
  source: 'api' | 'websocket' | 'none';
}

interface OutputState {
  buffers: { [terminalId: string]: OutputBuffer };
  maxBufferSize: number;
  maxChunks: number;
  cacheThreshold: number;
}

describe('outputSlice', () => {
  const initialState: OutputState = {
    buffers: {},
    maxBufferSize: 2000000,
    maxChunks: 500,
    cacheThreshold: 16,
  };

  describe('reducer', () => {
    it('should return the initial state', () => {
      const state = outputReducer(undefined, { type: 'unknown' });
      expect(state.buffers).toEqual({});
      expect(state.maxBufferSize).toBe(2000000);
      expect(state.maxChunks).toBe(500);
      expect(state.cacheThreshold).toBe(16);
    });
  });

  describe('appendOutput', () => {
    it('should append output to new terminal', () => {
      const action = appendOutput({
        terminalId: 'term-1',
        data: 'Hello World',
      });
      const state = outputReducer(initialState, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('Hello World');
    });

    it('should append output to existing terminal', () => {
      // Create initial state with existing data
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'Hello ',
      }));
      
      // Append more data
      const action = appendOutput({
        terminalId: 'term-1',
        data: 'World',
      });
      state = outputReducer(state, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('Hello World');
    });

    it('should handle multiple terminals', () => {
      let state = initialState;
      
      // Add output to term-1
      state = outputReducer(state, appendOutput({
        terminalId: 'term-1', 
        data: 'Terminal 1 output'
      }));
      
      // Add output to term-2
      state = outputReducer(state, appendOutput({
        terminalId: 'term-2',
        data: 'Terminal 2 output',
      }));
      
      const output1 = selectTerminalOutput({ output: state }, 'term-1');
      const output2 = selectTerminalOutput({ output: state }, 'term-2');
      expect(output1).toBe('Terminal 1 output');
      expect(output2).toBe('Terminal 2 output');
    });

    it('should handle empty data', () => {
      const action = appendOutput({
        terminalId: 'term-1',
        data: '',
      });
      const state = outputReducer(initialState, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('');
    });

    it('should handle special characters', () => {
      const action = appendOutput({
        terminalId: 'term-1',
        data: 'Line 1\nLine 2\r\nLine 3\tTabbed',
      });
      const state = outputReducer(initialState, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('Line 1\nLine 2\r\nLine 3\tTabbed');
    });
  });

  describe('clearOutput', () => {
    it('should clear output for specific terminal', () => {
      let state = initialState;
      
      // Add output to multiple terminals
      state = outputReducer(state, appendOutput({
        terminalId: 'term-1',
        data: 'Terminal 1 output',
      }));
      state = outputReducer(state, appendOutput({
        terminalId: 'term-2',
        data: 'Terminal 2 output',
      }));
      
      // Clear term-1
      const action = clearOutput('term-1');
      state = outputReducer(state, action);
      
      const output1 = selectTerminalOutput({ output: state }, 'term-1');
      const output2 = selectTerminalOutput({ output: state }, 'term-2');
      expect(output1).toBe('');
      expect(output2).toBe('Terminal 2 output');
    });

    it('should handle clearing non-existent terminal', () => {
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'Terminal 1 output',
      }));
      
      const action = clearOutput('term-999');
      state = outputReducer(state, action);
      
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('Terminal 1 output');
    });
  });

  describe('removeTerminalBuffer', () => {
    it('should remove a specific terminal buffer', () => {
      let state = initialState;
      
      // Add output to multiple terminals
      state = outputReducer(state, appendOutput({
        terminalId: 'term-1',
        data: 'Terminal 1 output',
      }));
      state = outputReducer(state, appendOutput({
        terminalId: 'term-2',
        data: 'Terminal 2 output',
      }));
      state = outputReducer(state, appendOutput({
        terminalId: 'term-3',
        data: 'Terminal 3 output',
      }));
      
      // Remove term-2
      const action = removeTerminalBuffer('term-2');
      state = outputReducer(state, action);
      
      const output1 = selectTerminalOutput({ output: state }, 'term-1');
      const output2 = selectTerminalOutput({ output: state }, 'term-2');
      const output3 = selectTerminalOutput({ output: state }, 'term-3');
      
      expect(output1).toBe('Terminal 1 output');
      expect(output2).toBe(''); // Should be empty for removed buffer
      expect(output3).toBe('Terminal 3 output');
    });

    it('should handle removing non-existent terminal', () => {
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'Terminal 1 output',
      }));
      
      const action = removeTerminalBuffer('term-999');
      state = outputReducer(state, action);
      
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('Terminal 1 output');
    });
  });

  describe('setOutput', () => {
    it('should set output for a terminal', () => {
      const action = setOutput({
        terminalId: 'term-1',
        data: 'New terminal output',
      });
      const state = outputReducer(initialState, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('New terminal output');
    });

    it('should replace existing API output', () => {
      // Use setOutput for initial data (API source)
      let state = outputReducer(initialState, setOutput({
        terminalId: 'term-1',
        data: 'Old output',
      }));

      // setOutput can replace API content with new API content
      const action = setOutput({
        terminalId: 'term-1',
        data: 'New output',
      });
      state = outputReducer(state, action);
      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output).toBe('New output');
    });
  });

  describe('selectTerminalOutput', () => {
    it('should return empty string for non-existent terminal', () => {
      const output = selectTerminalOutput({ output: initialState }, 'non-existent');
      expect(output).toBe('');
    });
    
    it('should return cached text when available', () => {
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'Test output',
      }));
      
      // Call selector twice to test caching
      const output1 = selectTerminalOutput({ output: state }, 'term-1');
      const output2 = selectTerminalOutput({ output: state }, 'term-1');
      
      expect(output1).toBe('Test output');
      expect(output2).toBe('Test output');
    });
  });

  describe('complex scenarios', () => {
    it('should handle sequential operations', () => {
      let state = initialState;

      // Add output to term-1
      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-1', data: 'Hello ' })
      );
      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-1', data: 'World\n' })
      );

      // Add output to term-2
      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-2', data: 'Terminal 2\n' })
      );

      let output1 = selectTerminalOutput({ output: state }, 'term-1');
      let output2 = selectTerminalOutput({ output: state }, 'term-2');
      expect(output1).toBe('Hello World\n');
      expect(output2).toBe('Terminal 2\n');

      // Clear term-1
      state = outputReducer(state, clearOutput('term-1'));
      output1 = selectTerminalOutput({ output: state }, 'term-1');
      output2 = selectTerminalOutput({ output: state }, 'term-2');
      expect(output1).toBe('');
      expect(output2).toBe('Terminal 2\n');

      // Add more to term-1
      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-1', data: 'New output' })
      );
      output1 = selectTerminalOutput({ output: state }, 'term-1');
      expect(output1).toBe('New output');

      // Remove term-2's buffer
      state = outputReducer(state, removeTerminalBuffer('term-2'));
      output1 = selectTerminalOutput({ output: state }, 'term-1');
      output2 = selectTerminalOutput({ output: state }, 'term-2');
      expect(output1).toBe('New output');
      expect(output2).toBe(''); // Should be empty for removed buffer
    });

    it('should handle large output accumulation', () => {
      let state = initialState;
      const largeData = 'A'.repeat(1000);

      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-1', data: largeData })
      );
      state = outputReducer(
        state,
        appendOutput({ terminalId: 'term-1', data: largeData })
      );

      const output = selectTerminalOutput({ output: state }, 'term-1');
      expect(output.length).toBe(2000);
    });
  });

  describe('source tracking', () => {
    it('should set source to websocket when using appendOutput on new buffer', () => {
      const action = appendOutput({
        terminalId: 'term-1',
        data: 'Hello WebSocket',
      });
      const state = outputReducer(initialState, action);
      expect(state.buffers['term-1'].source).toBe('websocket');
    });

    it('should set source to api when using setOutput', () => {
      const action = setOutput({
        terminalId: 'term-1',
        data: 'API content',
      });
      const state = outputReducer(initialState, action);
      expect(state.buffers['term-1'].source).toBe('api');
    });

    it('should clear API content when switching to WebSocket', () => {
      // First, set API content
      let state = outputReducer(initialState, setOutput({
        terminalId: 'term-1',
        data: 'API historical content',
      }));
      expect(state.buffers['term-1'].source).toBe('api');
      expect(selectTerminalOutput({ output: state }, 'term-1')).toBe('API historical content');

      // Then append WebSocket data - should clear API content and switch to websocket
      state = outputReducer(state, appendOutput({
        terminalId: 'term-1',
        data: 'WebSocket live data',
      }));

      expect(state.buffers['term-1'].source).toBe('websocket');
      // API content should be cleared, only WebSocket data remains
      expect(selectTerminalOutput({ output: state }, 'term-1')).toBe('WebSocket live data');
    });

    it('should ignore setOutput when buffer has WebSocket content', () => {
      // First, append WebSocket content
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'WebSocket live data',
      }));
      expect(state.buffers['term-1'].source).toBe('websocket');
      expect(selectTerminalOutput({ output: state }, 'term-1')).toBe('WebSocket live data');

      // Try to set API content - should be ignored
      state = outputReducer(state, setOutput({
        terminalId: 'term-1',
        data: 'API content that should be ignored',
      }));

      // Source should still be websocket and content unchanged
      expect(state.buffers['term-1'].source).toBe('websocket');
      expect(selectTerminalOutput({ output: state }, 'term-1')).toBe('WebSocket live data');
    });

    it('should reset source to none when clearing output', () => {
      // Create a buffer with websocket content
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'Some content',
      }));
      expect(state.buffers['term-1'].source).toBe('websocket');

      // Clear the output
      state = outputReducer(state, clearOutput('term-1'));
      expect(state.buffers['term-1'].source).toBe('none');
    });

    it('should allow setOutput after clearOutput resets source', () => {
      // Create WebSocket content
      let state = outputReducer(initialState, appendOutput({
        terminalId: 'term-1',
        data: 'WebSocket data',
      }));

      // Clear the buffer (resets source to none)
      state = outputReducer(state, clearOutput('term-1'));
      expect(state.buffers['term-1'].source).toBe('none');

      // Now setOutput should work
      state = outputReducer(state, setOutput({
        terminalId: 'term-1',
        data: 'New API content',
      }));
      expect(state.buffers['term-1'].source).toBe('api');
      expect(selectTerminalOutput({ output: state }, 'term-1')).toBe('New API content');
    });
  });
});