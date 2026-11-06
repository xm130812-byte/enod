//! SSE 广播：index-progress / doc-changed / doc-removed / clip-progress 等。

use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub event: String,
    pub data: Value,
}

#[derive(Clone)]
pub struct EventHub {
    tx: broadcast::Sender<ServerEvent>,
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl EventHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn broadcast(&self, event: &str, data: Value) {
        let _ = self.tx.send(ServerEvent {
            event: event.to_string(),
            data,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.tx.subscribe()
    }
}
