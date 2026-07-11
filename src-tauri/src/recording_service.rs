// Recording Service for terminal session recording

/// Hard cap on buffered events per active recording. At a typical TUI rate
/// (~1k events/sec) this is ~100 minutes of recording; beyond it we drop the
/// OLDEST events (keep the tail) and warn that the recording was truncated, instead of
/// growing without bound until stop_recording.
const MAX_RECORDING_EVENTS: usize = 200_000;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::path::PathBuf;
use std::fs;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingEvent {
    pub event_type: String, // "output", "input", "resize"
    pub data: String,
    pub timestamp: i64, // milliseconds since recording start
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingMetadata {
    pub title: Option<String>,
    pub shell_type: Option<String>,
    pub initial_size: TerminalSize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub terminal_id: String,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub events: Vec<RecordingEvent>,
    pub metadata: RecordingMetadata,
    pub size: usize,
    pub compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingOptions {
    pub include_input: bool,
    pub include_output: bool,
    pub include_resize: bool,
    pub compression: String, // "none", "gzip"
    pub auto_stop: bool,
}

impl Default for RecordingOptions {
    fn default() -> Self {
        Self {
            include_input: true,
            include_output: true,
            include_resize: true,
            compression: "gzip".to_string(),
            auto_stop: false,
        }
    }
}

pub struct ActiveRecording {
    pub recording: Recording,
    pub options: RecordingOptions,
    pub start_instant: std::time::Instant,
}

pub struct RecordingService {
    active_recordings: Arc<RwLock<HashMap<String, ActiveRecording>>>,
    recordings_path: PathBuf,
}

impl RecordingService {
    pub fn new() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        let path = PathBuf::from(&home).join(".auto-terminal").join("recordings");
        
        // Create directory if it doesn't exist
        let _ = fs::create_dir_all(&path);
        
        Self {
            active_recordings: Arc::new(RwLock::new(HashMap::new())),
            recordings_path: path,
        }
    }

    pub fn start_recording(
        &self,
        terminal_id: &str,
        options: RecordingOptions,
        initial_size: TerminalSize,
        shell_type: Option<String>,
    ) -> Result<String, String> {
        let recording_id = uuid::Uuid::new_v4().to_string();
        
        let recording = Recording {
            id: recording_id.clone(),
            terminal_id: terminal_id.to_string(),
            start_time: Utc::now(),
            end_time: None,
            events: Vec::new(),
            metadata: RecordingMetadata {
                title: None,
                shell_type,
                initial_size,
            },
            size: 0,
            compressed: options.compression == "gzip",
        };

        let active = ActiveRecording {
            recording,
            options,
            start_instant: std::time::Instant::now(),
        };

        let mut recordings = self.active_recordings.write().map_err(|e| e.to_string())?;
        recordings.insert(terminal_id.to_string(), active);
        
        Ok(recording_id)
    }

    pub fn stop_recording(&self, recording_id: &str) -> Result<Recording, String> {
        let mut recordings = self.active_recordings.write().map_err(|e| e.to_string())?;
        
        // Find by recording_id
        let terminal_id = recordings
            .iter()
            .find(|(_, v)| v.recording.id == recording_id)
            .map(|(k, _)| k.clone());
        
        if let Some(tid) = terminal_id {
            if let Some(mut active) = recordings.remove(&tid) {
                active.recording.end_time = Some(Utc::now());
                active.recording.size = active.recording.events.iter()
                    .map(|e| e.data.len())
                    .sum();
                
                // Save to disk
                self.save_recording(&active.recording)?;
                
                return Ok(active.recording);
            }
        }
        
        Err("Recording not found or not active".to_string())
    }

    pub fn add_event(
        &self,
        terminal_id: &str,
        event_type: &str,
        data: &str,
    ) -> Result<(), String> {
        let mut recordings = self.active_recordings.write().map_err(|e| e.to_string())?;
        
        if let Some(active) = recordings.get_mut(terminal_id) {
            // Check if this event type should be recorded
            let should_record = match event_type {
                "output" => active.options.include_output,
                "input" => active.options.include_input,
                "resize" => active.options.include_resize,
                _ => true,
            };
            
            if should_record {
                let elapsed = active.start_instant.elapsed().as_millis() as i64;
                active.recording.events.push(RecordingEvent {
                    event_type: event_type.to_string(),
                    data: data.to_string(),
                    timestamp: elapsed,
                });

                if active.recording.events.len() >= MAX_RECORDING_EVENTS {
                    // Evict a 10% batch (not just the overflow): a single-element
                    // drain would shift the whole Vec on EVERY event once the cap
                    // is reached. Batching makes the O(n) shift rare again
                    // (amortized ~10 shifts per 20k events).
                    let target = MAX_RECORDING_EVENTS - MAX_RECORDING_EVENTS / 10;
                    let overflow = active.recording.events.len() - target;
                    active.recording.events.drain(0..overflow);
                    log::warn!(
                        "Recording {} hit the {}-event cap; trimmed oldest events to {} (recording truncated)",
                        active.recording.id, MAX_RECORDING_EVENTS, target
                    );
                }
            }
        }
        
        Ok(())
    }

    pub fn is_recording(&self, terminal_id: &str) -> bool {
        self.active_recordings.read()
            .map(|r| r.contains_key(terminal_id))
            .unwrap_or(false)
    }

    pub fn get_active_recordings(&self) -> Vec<String> {
        self.active_recordings.read()
            .map(|r| r.values().map(|v| v.recording.id.clone()).collect())
            .unwrap_or_default()
    }

    fn save_recording(&self, recording: &Recording) -> Result<(), String> {
        let filename = format!("{}.json", recording.id);
        let path = self.recordings_path.join(&filename);
        
        let json = serde_json::to_string_pretty(recording).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
        
        Ok(())
    }

    pub fn load_recording(&self, recording_id: &str) -> Result<Recording, String> {
        let filename = format!("{}.json", recording_id);
        let path = self.recordings_path.join(&filename);
        
        let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    pub fn list_recordings(&self) -> Result<Vec<Recording>, String> {
        let mut recordings = Vec::new();
        
        if let Ok(entries) = fs::read_dir(&self.recordings_path) {
            for entry in entries.flatten() {
                if let Some(ext) = entry.path().extension() {
                    if ext == "json" {
                        if let Ok(json) = fs::read_to_string(entry.path()) {
                            if let Ok(recording) = serde_json::from_str::<Recording>(&json) {
                                recordings.push(recording);
                            }
                        }
                    }
                }
            }
        }
        
        recordings.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        Ok(recordings)
    }

    pub fn delete_recording(&self, recording_id: &str) -> Result<(), String> {
        let filename = format!("{}.json", recording_id);
        let path = self.recordings_path.join(&filename);
        
        fs::remove_file(&path).map_err(|e| e.to_string())
    }

    pub fn get_recording_info(&self, recording_id: &str) -> Result<serde_json::Value, String> {
        let recording = self.load_recording(recording_id)?;
        
        let duration = recording.end_time.map(|end| {
            (end - recording.start_time).num_milliseconds()
        });
        
        Ok(serde_json::json!({
            "id": recording.id,
            "terminalId": recording.terminal_id,
            "startTime": recording.start_time.to_rfc3339(),
            "endTime": recording.end_time.map(|t| t.to_rfc3339()),
            "eventCount": recording.events.len(),
            "size": recording.size,
            "compressed": recording.compressed,
            "duration": duration,
            "metadata": recording.metadata
        }))
    }

    // Export formats
    pub fn export_as_json(&self, recording_id: &str) -> Result<String, String> {
        let recording = self.load_recording(recording_id)?;
        serde_json::to_string_pretty(&recording).map_err(|e| e.to_string())
    }

    pub fn export_as_text(&self, recording_id: &str) -> Result<String, String> {
        let recording = self.load_recording(recording_id)?;
        let mut output = String::new();
        
        output.push_str(&format!("# Recording: {}\n", recording.id));
        output.push_str(&format!("# Terminal: {}\n", recording.terminal_id));
        output.push_str(&format!("# Start: {}\n", recording.start_time));
        if let Some(end) = recording.end_time {
            output.push_str(&format!("# End: {}\n", end));
        }
        output.push_str(&format!("# Events: {}\n\n", recording.events.len()));
        
        for event in recording.events.iter().filter(|e| e.event_type == "output") {
            output.push_str(&event.data);
        }
        
        Ok(output)
    }

    pub fn export_as_html(&self, recording_id: &str) -> Result<String, String> {
        let recording = self.load_recording(recording_id)?;
        let mut html = String::from(r#"<!DOCTYPE html>
<html>
<head>
    <title>Terminal Recording</title>
    <style>
        body { font-family: 'Courier New', monospace; background: #000; color: #fff; padding: 20px; }
        .metadata { color: #888; margin-bottom: 20px; }
        .terminal { background: #000; border: 1px solid #333; padding: 10px; }
        pre { margin: 0; white-space: pre-wrap; }
    </style>
</head>
<body>
"#);
        
        html.push_str(&format!("<div class=\"metadata\">\n"));
        html.push_str(&format!("<h3>Recording Information</h3>\n"));
        html.push_str(&format!("<p>ID: {}</p>\n", recording.id));
        html.push_str(&format!("<p>Terminal: {}</p>\n", recording.terminal_id));
        html.push_str(&format!("<p>Start: {}</p>\n", recording.start_time));
        html.push_str(&format!("<p>Events: {}</p>\n", recording.events.len()));
        html.push_str("</div>\n");
        
        html.push_str("<div class=\"terminal\"><pre>");
        for event in recording.events.iter().filter(|e| e.event_type == "output") {
            let escaped = event.data
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            html.push_str(&escaped);
        }
        html.push_str("</pre></div></body></html>");
        
        Ok(html)
    }

    pub fn export_as_asciinema(&self, recording_id: &str) -> Result<String, String> {
        let recording = self.load_recording(recording_id)?;
        
        let header = serde_json::json!({
            "version": 2,
            "width": recording.metadata.initial_size.cols,
            "height": recording.metadata.initial_size.rows,
            "timestamp": recording.start_time.timestamp(),
            "title": recording.metadata.title.as_deref().unwrap_or(&format!("Recording {}", recording.id)),
            "env": {
                "SHELL": recording.metadata.shell_type.as_deref().unwrap_or("/bin/bash"),
                "TERM": "xterm-256color"
            }
        });
        
        let mut lines = vec![serde_json::to_string(&header).map_err(|e| e.to_string())?];
        
        for event in &recording.events {
            if event.event_type == "output" {
                let asciinema_event = serde_json::json!([
                    event.timestamp as f64 / 1000.0, // Convert to seconds
                    "o", // output
                    event.data
                ]);
                lines.push(serde_json::to_string(&asciinema_event).map_err(|e| e.to_string())?);
            }
        }
        
        Ok(lines.join("\n"))
    }
}

impl Default for RecordingService {
    fn default() -> Self {
        Self::new()
    }
}
