//! 文件监听：notify（递归）+ 250ms 防抖，目录事件退化为全量重扫。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone, Debug)]
pub enum WatchEvent {
    Paths(Vec<PathBuf>),
    Rescan(String),
}

pub struct WatcherHandle {
    stop: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

impl WatcherHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 启动监听；事件经防抖后投递到 tokio 通道。
pub fn start(root: PathBuf, tx: UnboundedSender<WatchEvent>) -> notify::Result<WatcherHandle> {
    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(event) => {
            if event.paths.is_empty() {
                let _ = raw_tx.send(None);
            } else {
                for path in event.paths {
                    let _ = raw_tx.send(Some(path));
                }
            }
        }
        Err(_) => {
            let _ = raw_tx.send(None);
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    std::thread::Builder::new()
        .name("reader-watch".into())
        .spawn(move || {
            let mut pending: BTreeSet<PathBuf> = BTreeSet::new();
            let mut overflow = false;
            loop {
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                match raw_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Some(path)) => {
                        pending.insert(path);
                    }
                    Ok(None) => {
                        overflow = true;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if overflow {
                            overflow = false;
                            pending.clear();
                            let _ = tx.send(WatchEvent::Rescan("watch-overflow".into()));
                        } else if !pending.is_empty() {
                            let batch: Vec<PathBuf> = std::mem::take(&mut pending).into_iter().collect();
                            let _ = tx.send(WatchEvent::Paths(batch));
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| notify::Error::io(std::io::Error::other(e)))?;

    Ok(WatcherHandle {
        stop,
        _watcher: watcher,
    })
}
