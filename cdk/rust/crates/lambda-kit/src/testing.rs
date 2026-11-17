//! Helpers for testing functions built on this crate.

use std::io;
use std::sync::{Arc, Mutex, Once};

use serde_json::{Map, Value};
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::{DefaultGuard, Interest};
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::Registry;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;

use crate::logging;

/// Captures the lines [`logging`] would write, at every level, from this thread
/// while it lives.
///
/// A `#[tokio::test]` runs on one thread by default, so this sees what the code
/// under test logs.
///
/// ```
/// let logs = lambda_kit::testing::LogCapture::start();
/// tracing::warn!(attempt = 2, "Retrying");
///
/// assert_eq!(logs.lines()[0]["message"], "Retrying");
/// ```
pub struct LogCapture {
    buffer: Buffer,
    _guard: DefaultGuard,
}

impl LogCapture {
    /// Starts capturing, without a `service` key.
    pub fn start() -> Self {
        Self::with_service(None)
    }

    /// Starts capturing, with `service` as the `service` key.
    pub fn with_service(service: Option<&str>) -> Self {
        // Tests run on parallel threads, most without a capture. A log callsite one
        // of them reaches first would be cached as uninteresting everywhere, so this
        // capture would miss its lines; a global default that's interested
        // "sometimes" keeps each callsite asking the current thread's subscriber
        static UNDECIDED: Once = Once::new();
        UNDECIDED.call_once(|| {
            let _ = tracing::subscriber::set_global_default(Undecided);
        });

        let buffer = Buffer::default();
        let subscriber =
            Registry::default().with(logging::layer(service.map(str::to_owned), buffer.clone()));
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();

        LogCapture {
            buffer,
            _guard: guard,
        }
    }

    /// The lines so far, each a JSON object.
    pub fn lines(&self) -> Vec<Map<String, Value>> {
        self.buffer.lines()
    }
}

/// Records nothing, but never lets a callsite be cached as uninteresting.
struct Undecided;

impl Subscriber for Undecided {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn enabled(&self, _: &Metadata<'_>) -> bool {
        false
    }

    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, _: &Event<'_>) {}

    fn enter(&self, _: &Id) {}

    fn exit(&self, _: &Id) {}
}

/// Where captured lines are written.
#[derive(Clone, Default)]
pub(crate) struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Buffer {
    pub(crate) fn lines(&self) -> Vec<Map<String, Value>> {
        let output = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
        output
            .lines()
            .map(|line| match serde_json::from_str(line) {
                Ok(Value::Object(map)) => map,
                _ => panic!("not a JSON object: {line}"),
            })
            .collect()
    }
}

impl io::Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'w> MakeWriter<'w> for Buffer {
    type Writer = Buffer;

    fn make_writer(&'w self) -> Self::Writer {
        self.clone()
    }
}
