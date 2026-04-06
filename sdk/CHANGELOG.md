# Changelog

## [1.2.1](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.2.0...sdk-v1.2.1) (2026-04-06)


### Bug Fixes

* format CHANGELOG.md to pass vp check ([cb634de](https://github.com/flipboxlabs/aws-audit/commit/cb634de7fc81caf27a511166204afdfffbd6b7d0))
* **repository:** retry BatchWriteItem UnprocessedItems with exponential backoff ([7130a17](https://github.com/flipboxlabs/aws-audit/commit/7130a179b83fc7ef6edc800b317d333f7951e587))
* **repository:** retry BatchWriteItem UnprocessedItems with exponential backoff ([5a95440](https://github.com/flipboxlabs/aws-audit/commit/5a95440a911b7f6559534c9066e75b12995f9ee1)), closes [#18](https://github.com/flipboxlabs/aws-audit/issues/18)

## [1.2.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.1.3...sdk-v1.2.0) (2026-04-04)


### Features

* migrate to Vite+ toolchain and add CI workflow ([21c24f6](https://github.com/flipboxlabs/aws-audit/commit/21c24f6b1f37eb94e84d3b29d988fb242906d94d))

## [1.1.3](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.1.2...sdk-v1.1.3) (2026-04-04)

### Bug Fixes

- **sdk:** fix BatchHandler result accumulation — push instead of concat ([3c44b51](https://github.com/flipboxlabs/aws-audit/commit/3c44b519b7d3228200ff0258d7a9fa60edaa2bc0))
- **sdk:** fix BatchHandler result accumulation using push instead of concat ([4199724](https://github.com/flipboxlabs/aws-audit/commit/419972452177fdeddcd1e8644ffa142568b5a0ca)), closes [#14](https://github.com/flipboxlabs/aws-audit/issues/14)

## [1.1.2](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.1.1...sdk-v1.1.2) (2026-04-03)

### Bug Fixes

- drop get check for items with an id ([f680b08](https://github.com/flipboxlabs/aws-audit/commit/f680b082ff0462ef8b0aa457cf64cfdda8a91463))

## [1.1.1](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.1.0...sdk-v1.1.1) (2026-03-31)

### Bug Fixes

- bump docs ([2a5f2cc](https://github.com/flipboxlabs/aws-audit/commit/2a5f2cc38cab11ea3146bc9b8ffd7b61676f39d8))
- sync package versions to 1.1.0 ([172d74e](https://github.com/flipboxlabs/aws-audit/commit/172d74ecc2b8f29a3ee8467a3b8a76313e8cf20f))

## 1.0.0 (2026-03-31)

### Features

- initial commit ([8f0fb0f](https://github.com/flipboxlabs/aws-audit/commit/8f0fb0f95ff9a71059747ed0893998d8c428b963))
