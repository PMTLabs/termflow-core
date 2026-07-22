// Search Engine for terminal history
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::path::PathBuf;
use std::fs;
use chrono::{DateTime, Utc};
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchDocument {
    pub id: String,
    pub terminal_id: String,
    pub content: String,
    pub doc_type: String, // "output", "input", "error"
    pub timestamp: DateTime<Utc>,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub document: SearchDocument,
    pub score: f32,
    pub matches: Vec<(usize, usize)>, // start, end indices in content
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub query: String,
    pub filters: HashMap<String, String>,
    pub limit: usize,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SearchIndexData {
    documents: Vec<SearchDocument>,
}

pub struct SearchService {
    index: Arc<RwLock<SearchIndexData>>,
    index_path: PathBuf,
}

impl SearchService {
    pub fn new() -> Self {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        let path = PathBuf::from(&home)
            .join(".auto-terminal")
            .join(crate::app_config::dev_file("search_index.json"));
        
        let mut service = Self {
            index: Arc::new(RwLock::new(SearchIndexData::default())),
            index_path: path.clone(),
        };
        
        // Load existing index
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(data) = serde_json::from_str::<SearchIndexData>(&content) {
                    service.index = Arc::new(RwLock::new(data));
                }
            }
        }
        
        service
    }

    pub fn index_content(
        &self,
        terminal_id: &str,
        content: &str,
        doc_type: &str,
    ) {
        if content.trim().is_empty() {
            return;
        }

        let doc = SearchDocument {
            id: uuid::Uuid::new_v4().to_string(),
            terminal_id: terminal_id.to_string(),
            content: content.to_string(),
            doc_type: doc_type.to_string(),
            timestamp: Utc::now(),
            metadata: HashMap::new(),
        };

        {
            let mut index = self.index.write().unwrap();
            index.documents.push(doc);
        }
        
        // Persist occasionally? For now, let's persist on every write for safety, 
        // but in production we'd want to batch this.
        let _ = self.persist();
    }

    pub fn search(&self, query: SearchQuery) -> Vec<SearchMatch> {
        let index = self.index.read().unwrap();
        let mut results = Vec::new();
        let query_lower = query.query.to_lowercase();

        for doc in &index.documents {
            // Apply filters
            let mut matches_filters = true;
            for (curr_key, curr_val) in &query.filters {
                if curr_key == "terminalId" && &doc.terminal_id != curr_val {
                    matches_filters = false;
                    break;
                }
                if curr_key == "type" && &doc.doc_type != curr_val {
                    matches_filters = false;
                    break;
                }
            }
            if !matches_filters {
                continue;
            }

            // Text search
            let content_lower = doc.content.to_lowercase();
            if let Some(idx) = content_lower.find(&query_lower) {
                // Simple relevance score: explicit match
                let score = 1.0;
                
                // Extract context (e.g. 50 chars around match)
                let start = idx.saturating_sub(50);
                let end = (idx + query_lower.len() + 50).min(doc.content.len());
                let context = doc.content[start..end].to_string();

                results.push(SearchMatch {
                    document: doc.clone(),
                    score,
                    matches: vec![(idx, idx + query_lower.len())],
                    context,
                });
            }
        }

        // Sort by timestamp (newest first)
        results.sort_by(|a, b| b.document.timestamp.cmp(&a.document.timestamp));
        results.into_iter().take(query.limit).collect()
    }
    
    pub fn get_suggestions(&self, prefix: &str) -> Vec<String> {
        let index = self.index.read().unwrap();
        let prefix_lower = prefix.to_lowercase();
        let mut suggestions = std::collections::HashSet::new();
        
        for doc in &index.documents {
            // Very basic suggestion: unique words starting with prefix
            for word in doc.content.split_whitespace() {
                if word.to_lowercase().starts_with(&prefix_lower) {
                    suggestions.insert(word.to_string());
                }
            }
            
            if suggestions.len() >= 10 {
                break;
            }
        }
        
        suggestions.into_iter().collect()
    }

    pub fn clear_index(&self) -> Result<(), String> {
        {
            let mut index = self.index.write().unwrap();
            index.documents.clear();
        }
        self.persist().map_err(|e| e.to_string())
    }

    fn persist(&self) -> std::io::Result<()> {
        if let Some(parent) = self.index_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let index = self.index.read().unwrap();
        let json = serde_json::to_string_pretty(&*index)?;
        fs::write(&self.index_path, json)?;
        Ok(())
    }
}

impl Default for SearchService {
    fn default() -> Self {
        Self::new()
    }
}
