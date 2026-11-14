//! Audit ids: KSUIDs, which sort by creation time (`generateAuditId` in the
//! TypeScript SDK).

use svix_ksuid::{Ksuid, KsuidLike};

/// A new audit id: a 27-character base62 KSUID.
pub fn generate() -> String {
    Ksuid::new(None, None).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_unique_base62_ksuids() {
        let first = generate();
        let second = generate();

        assert_eq!(first.len(), 27);
        assert!(first.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(first, second);
    }
}
