//! An injectable source of the current time.
//!
//! Code that stamps records takes a [`Clock`] instead of calling `Utc::now()`, so
//! tests can fix the time with [`FixedClock`].

use chrono::{DateTime, SecondsFormat, Utc};

/// A source of the current time.
pub trait Clock: Send + Sync + std::fmt::Debug {
    /// The current time.
    fn now(&self) -> DateTime<Utc>;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A clock stopped at one instant.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock(pub DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

/// Formats a time the way JavaScript's `Date#toISOString` does: UTC, millisecond
/// precision and a `Z` suffix, e.g. `2026-01-02T03:04:05.678Z`.
pub fn to_iso_string(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_to_iso_string() {
        let time = DateTime::parse_from_rfc3339("2026-01-02T03:04:05.678Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(to_iso_string(time), "2026-01-02T03:04:05.678Z");
        assert_eq!(
            to_iso_string(DateTime::from_timestamp(0, 0).unwrap()),
            "1970-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn fixed_clock_returns_its_time() {
        let time = DateTime::from_timestamp(1_767_323_045, 678_000_000).unwrap();

        assert_eq!(FixedClock(time).now(), time);
    }
}
