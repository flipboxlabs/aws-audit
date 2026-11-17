//! Replays the fixtures in `contract/fixtures/http/config`.

use aws_audit::testing::contract_config;
use aws_audit_http::testing::replay_fixtures;
use config::{ConfigBody, router};

#[tokio::test]
async fn replays_every_config_fixture() {
    replay_fixtures("http/config", |_| {
        router(ConfigBody::new(
            &contract_config(),
            "0.0.0-contract".to_owned(),
        ))
    })
    .await;
}
