//! Replays the fixtures in `contract/fixtures/http/config`.

use aws_audit::testing::{contract_config, fixtures};
use aws_audit_http::testing::{answer, check_response_schema, compare_response, request};
use config::{ConfigBody, router};

#[tokio::test]
async fn replays_every_config_fixture() {
    let fixtures = fixtures("http/config");
    assert!(!fixtures.is_empty(), "no config fixtures found");

    let router = router(ConfigBody::new(
        &contract_config(),
        "0.0.0-contract".to_owned(),
    ));
    let mut failures = Vec::new();
    for (name, fixture) in &fixtures {
        let answer = answer(&router.handle(request(fixture)).await);
        failures.extend(compare_response(name, &answer, &fixture["response"]));
        if answer["statusCode"] == 200 {
            failures.extend(check_response_schema(name, "config", &answer["body"]));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
