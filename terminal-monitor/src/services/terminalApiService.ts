import axiosInstance from './axiosConfig';

interface TerminalOutput {
  lines: string[];
  totalLines: number;
  offset: number;
  raw: string;
}

interface TestCaptureMetadata {
  stripped: boolean;
  originalLength: number;
  processedLength: number;
  timestamp: number;
  reason: 'initial_load' | 'resize' | 'diverged' | 'incremental';
}

interface CaptureComparisonResult {
  match: boolean;
  backendSize: number;
  frontendSize: number;
  diffSummary?: string;
}

interface CapturedContent {
  content: string;
  line_count: number;
  includes_scrollback: boolean;
  cursor_position?: [number, number];
}

interface ResizeReflowResponse {
  status: string;
  cols: number;
  rows: number;
  content?: CapturedContent;
  reflow_applied: boolean;
}

interface TmuxStatus {
  available: boolean;
  tmux_path: string;
  wsl_distro?: string;
  active_sessions: number;
}

class TerminalApiService {
  /**
   * Fetch terminal output
   */
  async getTerminalOutput(
    terminalId: string,
    lines: number = 1000,
    offset: number = 0
  ): Promise<TerminalOutput> {
    try {
      const response = await axiosInstance.get<TerminalOutput>(
        `/api/terminals/${terminalId}/output`,
        {
          params: { lines, offset },
        }
      );
      return response.data;
    } catch (error) {
      console.error(
        `Failed to fetch output for terminal ${terminalId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Fetch a styled escape-sequence snapshot of the terminal's current screen.
   * Optionally aligns the parser to the given cols/rows before snapshotting.
   */
  async getSnapshot(
    terminalId: string,
    cols?: number,
    rows?: number
  ): Promise<{ snapshot: string; rows: number; cols: number }> {
    const params: Record<string, number> = {};
    if (cols && cols > 0) params.cols = cols;
    if (rows && rows > 0) params.rows = rows;
    const response = await axiosInstance.get(
      `/api/terminals/${terminalId}/snapshot`,
      { params }
    );
    return response.data;
  }

  /**
   * Send input to terminal
   */
  async sendInput(terminalId: string, data: string): Promise<void> {
    try {
      await axiosInstance.post(`/api/terminals/${terminalId}/input`, { data });
    } catch (error) {
      console.error(`Failed to send input to terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Resize terminal
   */
  async resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    try {
      await axiosInstance.post(`/api/terminals/${terminalId}/resize`, {
        cols,
        rows,
      });
    } catch (error) {
      console.error(`Failed to resize terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Capture frontend processed data for testing
   */
  async captureForTest(
    terminalId: string,
    testId: string,
    data: string,
    metadata?: TestCaptureMetadata
  ): Promise<void> {
    try {
      await axiosInstance.post('/api/test/capture-frontend', {
        terminalId,
        testId,
        data,
        metadata,
      });
    } catch (error) {
      console.warn('[Test Capture] Failed to capture frontend data:', error);
      // Don't throw - test capture should not break normal operation
    }
  }

  /**
   * Compare backend vs frontend captures
   */
  async compareCaptures(
    testId: string,
    terminalId: string
  ): Promise<CaptureComparisonResult> {
    const response = await axiosInstance.get<CaptureComparisonResult>(
      `/api/test/compare/${testId}/${terminalId}`
    );
    return response.data;
  }

  /**
   * Resize terminal with content reflow (if tmux backend)
   */
  async resizeWithReflow(
    terminalId: string,
    cols: number,
    rows: number
  ): Promise<ResizeReflowResponse> {
    try {
      const response = await axiosInstance.post<ResizeReflowResponse>(
        `/api/terminals/${terminalId}/resize-reflow`,
        { cols, rows }
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to resize with reflow for terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Get tmux availability status
   */
  async getTmuxStatus(): Promise<TmuxStatus> {
    try {
      const response = await axiosInstance.get<TmuxStatus>('/api/system/tmux-status');
      return response.data;
    } catch (error) {
      console.error('Failed to get tmux status:', error);
      throw error;
    }
  }
}

export default new TerminalApiService();
