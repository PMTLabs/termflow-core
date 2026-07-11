// Event Bus for centralized event handling
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalEvent {
    pub id: String,
    pub event_type: String,
    pub terminal_id: Option<String>,
    pub data: serde_json::Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventHistory {
    events: VecDeque<TerminalEvent>,
    max_size: usize,
}

impl EventHistory {
    pub fn new(max_size: usize) -> Self {
        Self {
            events: VecDeque::with_capacity(max_size),
            max_size,
        }
    }

    pub fn push(&mut self, event: TerminalEvent) {
        if self.events.len() >= self.max_size {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    pub fn get_recent(&self, count: usize) -> Vec<TerminalEvent> {
        self.events.iter().rev().take(count).cloned().collect()
    }

    pub fn get_by_terminal(&self, terminal_id: &str, count: usize) -> Vec<TerminalEvent> {
        self.events
            .iter()
            .rev()
            .filter(|e| e.terminal_id.as_deref() == Some(terminal_id))
            .take(count)
            .cloned()
            .collect()
    }

    pub fn clear(&mut self) {
        self.events.clear();
    }
    
    pub fn len(&self) -> usize {
        self.events.len()
    }
}

pub struct EventBus {
    history: Arc<RwLock<EventHistory>>,
    batch_buffer: Arc<RwLock<Vec<TerminalEvent>>>,
    batch_size: usize,
}

impl EventBus {
    pub fn new(history_size: usize, batch_size: usize) -> Self {
        Self {
            history: Arc::new(RwLock::new(EventHistory::new(history_size))),
            batch_buffer: Arc::new(RwLock::new(Vec::with_capacity(batch_size))),
            batch_size,
        }
    }

    pub fn emit(&self, event_type: &str, terminal_id: Option<&str>, data: serde_json::Value) {
        let event = TerminalEvent {
            id: uuid::Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            terminal_id: terminal_id.map(|s| s.to_string()),
            data,
            timestamp: Utc::now(),
        };

        // Add to batch buffer
        {
            let mut buffer = self.batch_buffer.write().unwrap();
            buffer.push(event.clone());
            
            // Flush if batch is full
            if buffer.len() >= self.batch_size {
                let events: Vec<_> = buffer.drain(..).collect();
                drop(buffer);
                self.flush_to_history(events);
            }
        }
    }

    fn flush_to_history(&self, events: Vec<TerminalEvent>) {
        let mut history = self.history.write().unwrap();
        for event in events {
            history.push(event);
        }
    }

    pub fn flush(&self) {
        let events: Vec<_> = {
            let mut buffer = self.batch_buffer.write().unwrap();
            buffer.drain(..).collect()
        };
        if !events.is_empty() {
            self.flush_to_history(events);
        }
    }

    pub fn get_history(&self, count: usize) -> Vec<TerminalEvent> {
        self.flush();
        let history = self.history.read().unwrap();
        history.get_recent(count)
    }

    pub fn get_terminal_history(&self, terminal_id: &str, count: usize) -> Vec<TerminalEvent> {
        self.flush();
        let history = self.history.read().unwrap();
        history.get_by_terminal(terminal_id, count)
    }

    pub fn clear_history(&self) {
        let mut history = self.history.write().unwrap();
        history.clear();
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(1000, 10) // 1000 events history, batch size of 10
    }
}

// Activity tracking for terminals
#[derive(Debug, Clone)]
pub struct ActivityTracker {
    last_activity: Arc<RwLock<std::collections::HashMap<String, DateTime<Utc>>>>,
    inactive_threshold_secs: i64,
}

impl ActivityTracker {
    pub fn new(inactive_threshold_secs: i64) -> Self {
        Self {
            last_activity: Arc::new(RwLock::new(std::collections::HashMap::new())),
            inactive_threshold_secs,
        }
    }

    pub fn record_activity(&self, terminal_id: &str) {
        let mut activity = self.last_activity.write().unwrap();
        activity.insert(terminal_id.to_string(), Utc::now());
    }

    pub fn is_active(&self, terminal_id: &str) -> bool {
        let activity = self.last_activity.read().unwrap();
        if let Some(last) = activity.get(terminal_id) {
            let elapsed = Utc::now().signed_duration_since(*last);
            elapsed.num_seconds() < self.inactive_threshold_secs
        } else {
            false
        }
    }

    pub fn get_inactive_terminals(&self) -> Vec<String> {
        let activity = self.last_activity.read().unwrap();
        let now = Utc::now();
        activity
            .iter()
            .filter(|(_, last)| {
                now.signed_duration_since(**last).num_seconds() >= self.inactive_threshold_secs
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn remove(&self, terminal_id: &str) {
        let mut activity = self.last_activity.write().unwrap();
        activity.remove(terminal_id);
    }
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new(30) // 30 seconds inactivity threshold
    }
}
