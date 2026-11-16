//! Exponential backoff with jitter, for retrying throttled or failed AWS calls.
//!
//! [`Backoff`] only computes and waits out delays; the caller owns the loop, since
//! what to resend differs by call (a whole request, or only the unprocessed part of
//! a batch):
//!
//! ```no_run
//! # use lambda_kit::retry::{Backoff, RandomJitter};
//! # async fn send() -> Result<(), ()> { Ok(()) }
//! # async fn example() -> Result<(), ()> {
//! let backoff = Backoff::default();
//! let mut attempt = 1;
//! loop {
//!     match send().await {
//!         Err(_) if attempt < backoff.attempts => {
//!             backoff.wait(attempt, &RandomJitter).await;
//!             attempt += 1;
//!         }
//!         result => return result,
//!     }
//! }
//! # }
//! ```

use std::time::Duration;

/// A source of random numbers in `[0, 1)` for jittering delays.
pub trait Jitter: Send + Sync + std::fmt::Debug {
    /// A number in `[0, 1)`.
    fn sample(&self) -> f64;
}

/// Jitter from the thread's random number generator.
#[derive(Debug, Clone, Copy, Default)]
pub struct RandomJitter;

impl Jitter for RandomJitter {
    fn sample(&self) -> f64 {
        rand::random::<f64>()
    }
}

/// The same sample every time, for deterministic tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedJitter(pub f64);

impl Jitter for FixedJitter {
    fn sample(&self) -> f64 {
        self.0
    }
}

/// Exponential backoff with "equal jitter": the delay before retry `n` is between
/// half and all of `base * 2^(n - 1)`, capped at `max_delay`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    /// Total attempts, including the first. At least 1.
    pub attempts: u32,
    /// The delay ceiling before the first retry.
    pub base: Duration,
    /// The largest delay ceiling.
    pub max_delay: Duration,
}

impl Default for Backoff {
    /// 3 attempts, 100 ms base, 30 s cap.
    fn default() -> Self {
        Self {
            attempts: 3,
            base: Duration::from_millis(100),
            max_delay: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    /// The delay after failed attempt `attempt` (1-based), for a jitter sample in
    /// `[0, 1)`. Rounded to whole milliseconds.
    pub fn delay(&self, attempt: u32, sample: f64) -> Duration {
        let exponent = attempt.saturating_sub(1).min(31);
        let ceiling = self
            .base
            .saturating_mul(2u32.saturating_pow(exponent))
            .min(self.max_delay)
            .as_secs_f64()
            * 1000.0;
        let millis = (ceiling / 2.0 + sample.clamp(0.0, 1.0) * ceiling / 2.0).round();

        Duration::from_millis(millis as u64)
    }

    /// Whether another attempt follows failed attempt `attempt`.
    pub fn should_retry(&self, attempt: u32) -> bool {
        attempt < self.attempts
    }

    /// Sleeps for the delay after failed attempt `attempt`, and returns it.
    pub async fn wait(&self, attempt: u32, jitter: &dyn Jitter) -> Duration {
        let delay = self.delay(attempt, jitter.sample());
        tokio::time::sleep(delay).await;
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_doubles_between_half_and_all_of_the_ceiling() {
        let backoff = Backoff::default();

        assert_eq!(backoff.delay(1, 0.0), Duration::from_millis(50));
        assert_eq!(backoff.delay(1, 0.5), Duration::from_millis(75));
        assert_eq!(backoff.delay(2, 0.5), Duration::from_millis(150));
        assert_eq!(backoff.delay(3, 0.999_999), Duration::from_millis(400));
    }

    #[test]
    fn delay_is_capped() {
        let backoff = Backoff::default();

        assert_eq!(backoff.delay(20, 0.5), Duration::from_millis(22_500));
        assert_eq!(backoff.delay(u32::MAX, 1.0), Duration::from_secs(30));
    }

    #[test]
    fn retries_until_attempts_run_out() {
        let backoff = Backoff::default();

        assert!(backoff.should_retry(1));
        assert!(backoff.should_retry(2));
        assert!(!backoff.should_retry(3));
    }

    #[tokio::test(start_paused = true)]
    async fn wait_sleeps_for_the_delay() {
        let start = tokio::time::Instant::now();

        let delay = Backoff::default().wait(2, &FixedJitter(0.5)).await;

        assert_eq!(delay, Duration::from_millis(150));
        assert_eq!(start.elapsed(), delay);
    }
}
