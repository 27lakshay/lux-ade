//! Opt-in benchmark instrumentation; no sampling or file IO in normal use.
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
static PATH: OnceLock<Option<String>> = OnceLock::new();
static SAMPLES: OnceLock<Mutex<BTreeMap<String, Vec<u64>>>> = OnceLock::new();
pub fn enabled() -> bool {
    PATH.get_or_init(|| std::env::var("ADE_BENCH_LOG").ok())
        .is_some()
}
pub fn sample(name: &str, micros: u64) {
    if !enabled() {
        return;
    }
    let mut all = SAMPLES.get_or_init(Default::default).lock().unwrap();
    let samples = all.entry(name.into()).or_default();
    if samples.len() < 100_000 {
        samples.push(micros);
    }
}
pub fn elapsed(name: &str, start: Instant) {
    sample(name, start.elapsed().as_micros() as u64);
}
pub fn output(bytes: &[u8]) {
    if !enabled() {
        return;
    }
    // The fixture emits short atomic lines; split markers are omitted, never
    // guessed. Counts in the report expose missing samples.
    let text = String::from_utf8_lossy(bytes);
    for tail in text.split("ADE_PING:").skip(1) {
        if let Some((value, _)) = tail.split_once(';')
            && let Ok(start) = value.parse::<u64>()
        {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as u64;
            if let Some(delta) = now.checked_sub(start) {
                sample("input_to_native_apply_us", delta);
            }
        }
    }
}
pub fn flush() {
    if !enabled() {
        return;
    }
    let all = SAMPLES.get_or_init(Default::default).lock().unwrap();
    let mut result = BTreeMap::new();
    for (key, samples) in all.iter() {
        if samples.is_empty() {
            continue;
        }
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        let n = sorted.len();
        result.insert(
            key,
            json!({"count":n,"p50":sorted[n/2],"p95":sorted[(n-1)*95/100],"max":sorted[n-1]}),
        );
    }
    let path = PATH.get().unwrap().as_ref().unwrap();
    let temporary = format!("{path}.next");
    if std::fs::write(&temporary, serde_json::to_vec_pretty(&result).unwrap()).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

pub fn restored() {
    if !enabled() {
        return;
    }
    if let Ok(start) = std::env::var("ADE_BENCH_START_US")
        .unwrap_or_default()
        .parse::<u64>()
    {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        if let Some(delta) = now.checked_sub(start) {
            sample("launch_to_restored_us", delta);
        }
    }
}

/// Synthetic-provider timestamps only; never applied to ordinary Conversation text.
pub fn agent_marker(text: &str) -> Option<u64> {
    if !enabled() {
        return None;
    }
    let marker = text.rsplit_once("ADE_AGENT:")?.1.split_once(';')?.0;
    marker.parse().ok()
}
pub fn latency(name: &str, start: u64) {
    if !enabled() {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;
    if let Some(elapsed) = now.checked_sub(start) {
        sample(name, elapsed);
    }
}
pub fn agent_messages(name: &str, messages: &[ade_core::model::Message]) {
    if !enabled() {
        return;
    }
    static SEEN: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
    let mut seen = SEEN.get_or_init(Default::default).lock().unwrap();
    for m in messages {
        if let Some(stamp) = agent_marker(&m.text) {
            let key = format!("{name}:{}", m.id);
            let old = seen.entry(key).or_default();
            if stamp > *old {
                *old = stamp;
                latency(name, stamp);
            }
        }
    }
}
