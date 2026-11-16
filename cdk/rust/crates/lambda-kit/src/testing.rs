//! Helpers for testing functions built on this crate.

use std::io;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tracing::subscriber::DefaultGuard;
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
        let buffer = Buffer::default();
        let subscriber =
            Registry::default().with(logging::layer(service.map(str::to_owned), buffer.clone()));

        LogCapture {
            buffer,
            _guard: tracing::subscriber::set_default(subscriber),
        }
    }

    /// The lines so far, each a JSON object.
    pub fn lines(&self) -> Vec<Map<String, Value>> {
        self.buffer.lines()
    }
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
