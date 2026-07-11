import axiosInstance from './axiosConfig';
import {
  TerminalRecording,
  RecordingListItem,
  RecordingResponse,
  RecordingStatus,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingResponse,
  RecordingExportOptions,
} from '../types/recording';

class RecordingApiService {
  /**
   * Start recording a terminal session
   */
  async startRecording(request: StartRecordingRequest): Promise<StartRecordingResponse> {
    try {
      const response = await axiosInstance.post<StartRecordingResponse>(
        '/api/recordings/start',
        request
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to start recording for terminal ${request.terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Stop recording a terminal session
   */
  async stopRecording(recordingId: string): Promise<StopRecordingResponse> {
    try {
      const response = await axiosInstance.post<StopRecordingResponse>(
        `/api/recordings/stop/${recordingId}`
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to stop recording ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Get list of recordings
   */
  async getRecordings(
    limit: number = 100,
    offset: number = 0,
    terminalId?: string
  ): Promise<RecordingResponse> {
    try {
      const params: any = { limit, offset };
      if (terminalId) {
        params.terminalId = terminalId;
      }

      const response = await axiosInstance.get<RecordingResponse>('/api/recordings', {
        params,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to fetch recordings:', error);
      throw error;
    }
  }

  /**
   * Get a specific recording
   */
  async getRecording(recordingId: string, includeEvents: boolean = false): Promise<TerminalRecording> {
    try {
      const response = await axiosInstance.get<TerminalRecording>(
        `/api/recordings/${recordingId}`,
        {
          params: { includeEvents: includeEvents.toString() },
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch recording ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Get recording info (metadata without events)
   */
  async getRecordingInfo(recordingId: string): Promise<Partial<TerminalRecording>> {
    try {
      const response = await axiosInstance.get<Partial<TerminalRecording>>(
        `/api/recordings/${recordingId}/info`
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch recording info ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a recording
   */
  async deleteRecording(recordingId: string): Promise<void> {
    try {
      await axiosInstance.delete(`/api/recordings/${recordingId}`);
    } catch (error) {
      console.error(`Failed to delete recording ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Export a recording
   */
  async exportRecording(
    recordingId: string,
    options: RecordingExportOptions
  ): Promise<Blob> {
    try {
      const response = await axiosInstance.post(
        `/api/recordings/${recordingId}/export`,
        options,
        {
          responseType: 'blob',
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to export recording ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Get recording status for a terminal
   */
  async getRecordingStatus(terminalId: string): Promise<RecordingStatus> {
    try {
      const response = await axiosInstance.get<RecordingStatus>(
        `/api/recordings/status/${terminalId}`
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to get recording status for terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Get active recordings
   */
  async getActiveRecordings(): Promise<{ activeRecordings: string[]; count: number }> {
    try {
      const response = await axiosInstance.get('/api/recordings/active');
      return response.data;
    } catch (error) {
      console.error('Failed to get active recordings:', error);
      throw error;
    }
  }

  /**
   * Download exported recording
   */
  downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Export and download recording in specified format
   */
  async exportAndDownloadRecording(
    recordingId: string,
    format: 'json' | 'text' | 'html' | 'asciinema',
    includeMetadata: boolean = true
  ): Promise<void> {
    try {
      const options: RecordingExportOptions = {
        format,
        includeMetadata,
        includeTimestamps: true,
        colorOutput: true,
      };

      const blob = await this.exportRecording(recordingId, options);
      const extension = format === 'text' ? 'txt' : format === 'asciinema' ? 'cast' : format;
      const filename = `recording-${recordingId}.${extension}`;
      
      this.downloadBlob(blob, filename);
    } catch (error) {
      console.error(`Failed to export and download recording ${recordingId}:`, error);
      throw error;
    }
  }

  /**
   * Get recording duration in a human-readable format
   */
  formatDuration(ms: number | null): string {
    if (!ms) return 'Unknown';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /**
   * Format file size in a human-readable format
   */
  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Format timestamp for display
   */
  formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  }
}

export default new RecordingApiService();