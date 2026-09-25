//! Each browser retains one pending state update and one wake-up token.
//! Native callbacks replace or merge obsolete state without waiting for the UI.
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(crate) struct Sender<T> {
    latest: Arc<Mutex<Option<T>>>,
    wake: async_channel::Sender<()>,
}
pub(crate) struct Receiver<T> {
    latest: Arc<Mutex<Option<T>>>,
    wake: async_channel::Receiver<()>,
}
pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let latest = Arc::new(Mutex::new(None));
    let (tx, rx) = async_channel::bounded(1);
    (
        Sender {
            latest: latest.clone(),
            wake: tx,
        },
        Receiver { latest, wake: rx },
    )
}
impl<T> Sender<T> {
    pub(crate) fn publish(&self, value: T) {
        self.update(|pending| *pending = Some(value));
    }
    pub(crate) fn update(&self, update: impl FnOnce(&mut Option<T>)) {
        if self.wake.is_closed() {
            return;
        }
        update(&mut self.latest.lock().unwrap());
        // A full channel already has the wake-up needed to read the latest state.
        let _ = self.wake.try_send(());
    }
}
impl<T> Receiver<T> {
    pub(crate) async fn recv(&self) -> Result<T, async_channel::RecvError> {
        loop {
            self.wake.recv().await?;
            if let Some(value) = self.latest.lock().unwrap().take() {
                return Ok(value);
            }
            // A newer value can be consumed before its wake-up arrives.
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_burst_retains_the_latest_address() {
        let (tx, rx) = channel();
        for index in 0..100 {
            tx.publish(format!("https://example.test/{index}"));
        }
        drop(tx);
        let mut latest = String::new();
        loop {
            let mut read = std::pin::pin!(rx.recv());
            match std::future::Future::poll(
                read.as_mut(),
                &mut std::task::Context::from_waker(std::task::Waker::noop()),
            ) {
                std::task::Poll::Ready(Ok(url)) => latest = url,
                std::task::Poll::Ready(Err(_)) => break,
                std::task::Poll::Pending => panic!("closed producer must finish draining"),
            }
        }
        assert_eq!(
            latest, "https://example.test/99",
            "navigation burst leaves the address stale"
        );
    }
}
