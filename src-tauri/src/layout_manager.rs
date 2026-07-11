// Layout Manager for UI state persistence
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::fs;
use serde_json::Value;

pub struct LayoutManager {
    layout_path: PathBuf,
    current_layout: Arc<RwLock<Option<Value>>>,
}

impl LayoutManager {
    pub fn new() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        let path = PathBuf::from(&home).join(".auto-terminal").join("layout.json");
        
        let manager = Self {
            layout_path: path.clone(),
            current_layout: Arc::new(RwLock::new(None)),
        };
        
        // Load on startup
        manager.load_from_disk();
        
        manager
    }

    fn load_from_disk(&self) {
        if self.layout_path.exists() {
            if let Ok(content) = fs::read_to_string(&self.layout_path) {
                if let Ok(layout) = serde_json::from_str::<Value>(&content) {
                    let mut lock = self.current_layout.write().unwrap();
                    *lock = Some(layout);
                }
            }
        }
    }

    pub fn save_layout(&self, layout: Value) -> Result<(), String> {
        // Update memory
        {
            let mut lock = self.current_layout.write().unwrap();
            *lock = Some(layout.clone());
        }
        
        // Ensure directory exists
        if let Some(parent) = self.layout_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        
        // Save to disk
        let json = serde_json::to_string_pretty(&layout).map_err(|e| e.to_string())?;
        fs::write(&self.layout_path, json).map_err(|e| e.to_string())?;
        
        Ok(())
    }

    pub fn get_layout(&self) -> Option<Value> {
        let lock = self.current_layout.read().unwrap();
        lock.clone()
    }
}

impl Default for LayoutManager {
    fn default() -> Self {
        Self::new()
    }
}
