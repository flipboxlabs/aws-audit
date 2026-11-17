//! Replays the fixtures in `contract/fixtures/http/trace`.

use std::sync::Arc;

use aws_audit::testing::{Recorder, contract_config, contract_service};
use aws_audit_http::testing::replay_fixtures;
use lambda_kit::http::Router;
use trace::{State, router};

fn contract_router(recorder: &Arc<Recorder>) -> Router<State> {
    router(State {
        config: Arc::new(contract_config()),
        service: contract_service(recorder),
    })
}

#[tokio::test(start_paused = true)]
async fn replays_every_trace_fixture() {
    replay_fixtures("http/trace", contract_router).await;
}
