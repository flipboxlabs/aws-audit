# Changelog

## [1.6.2](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.6.1...sdk-v1.6.2) (2026-11-14)


### Bug Fixes

* **sdk:** add the record TTL in epoch seconds, not local time ([8e422cb](https://github.com/flipboxlabs/aws-audit/commit/8e422cb937e188aa709c5b81529477df13fe51b3))

## [1.6.1](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.6.0...sdk-v1.6.1) (2026-11-13)


### Bug Fixes

* **sdk:** include related-resource audits in filtered trace and status listings ([9a68373](https://github.com/flipboxlabs/aws-audit/commit/9a68373990a88fe16240c93860969fb37df5ab58))

## [1.6.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.5.4...sdk-v1.6.0) (2026-11-13)


### Features

* **sdk:** add BatchHandler.putEventsWithRetry ([f305ba6](https://github.com/flipboxlabs/aws-audit/commit/f305ba65a3313ff7a959edc06e7f8ec40513ed1e)), closes [#108](https://github.com/flipboxlabs/aws-audit/issues/108)


### Bug Fixes

* **sdk:** keep AuditEventBus.upserted never-throw and add upsertedOrThrow ([439c220](https://github.com/flipboxlabs/aws-audit/commit/439c220b3a3cdda6c4885ea1f2eff30441a98422)), closes [#108](https://github.com/flipboxlabs/aws-audit/issues/108)
* **sdk:** only retry transient EventBridge rejections in putEventsWithRetry ([67c6ae9](https://github.com/flipboxlabs/aws-audit/commit/67c6ae9b8bba8ff93559d455de2fb98139305537)), closes [#108](https://github.com/flipboxlabs/aws-audit/issues/108)
* **sdk:** retry rejected Upserted events and log when they can't be published ([c81e756](https://github.com/flipboxlabs/aws-audit/commit/c81e75644a057b34f3857cee6f6f6b520beeb5e5))
* **sdk:** retry rejected Upserted events and log when they can't be published ([9f93fea](https://github.com/flipboxlabs/aws-audit/commit/9f93fea5936fbafa3624c525b85e3e5404ec67f3)), closes [#108](https://github.com/flipboxlabs/aws-audit/issues/108)

## [1.5.4](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.5.3...sdk-v1.5.4) (2026-11-13)


### Bug Fixes

* answer 404 when the requested audit doesn't exist ([d6b5ba0](https://github.com/flipboxlabs/aws-audit/commit/d6b5ba0cdbdf5806896567e235fc5996988e1b18))
* **sdk:** log getItem read failures accurately and copy not-found identifiers ([3f8d263](https://github.com/flipboxlabs/aws-audit/commit/3f8d2638b6c030c681d14330bef6d5985d2406ea))

## [1.5.3](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.5.2...sdk-v1.5.3) (2026-11-13)


### Bug Fixes

* **cdk:** answer 500 when rerun can't re-send the event ([18bb1df](https://github.com/flipboxlabs/aws-audit/commit/18bb1df802998a395af9c2a7f5e1a5e837ebd6ed))

## [1.5.2](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.5.1...sdk-v1.5.2) (2026-11-13)


### Bug Fixes

* **sdk:** drop a NULL trace instead of failing to parse the audit ([e4bc654](https://github.com/flipboxlabs/aws-audit/commit/e4bc6543938299967b00f71a38eb8387e2bd902d)), closes [#91](https://github.com/flipboxlabs/aws-audit/issues/91)
* **sdk:** filter trace listings on the nested audit target ([02b3072](https://github.com/flipboxlabs/aws-audit/commit/02b30727ab7ae3ecea61491c8a0b4ca6f57c0dc0))
* **sdk:** filter trace listings on the nested audit target ([24d380e](https://github.com/flipboxlabs/aws-audit/commit/24d380e4a3aaeb2052de849fc57343c526117f80)), closes [#89](https://github.com/flipboxlabs/aws-audit/issues/89)
* **sdk:** ignore caller-supplied attempts in upsertItem ([1b88393](https://github.com/flipboxlabs/aws-audit/commit/1b883939c4487b766766e6956b177de5adea96d8))
* **sdk:** ignore caller-supplied attempts in upsertItem ([26efbf1](https://github.com/flipboxlabs/aws-audit/commit/26efbf10defac53dcad419ab1aaa8e6db013fe36)), closes [#92](https://github.com/flipboxlabs/aws-audit/issues/92)
* **sdk:** return the trace an audit was written with ([edb85ee](https://github.com/flipboxlabs/aws-audit/commit/edb85eead353f0f55e49db1d38329b8014b2abcd))
* **sdk:** return the trace an audit was written with ([091d022](https://github.com/flipboxlabs/aws-audit/commit/091d02245a0dda9aff1c216e0156765b62bf538f)), closes [#91](https://github.com/flipboxlabs/aws-audit/issues/91)

## [1.5.1](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.5.0...sdk-v1.5.1) (2026-11-12)


### Bug Fixes

* **sdk:** generate audit storage id per parse instead of at import ([e755cbe](https://github.com/flipboxlabs/aws-audit/commit/e755cbed2bd3d8c9e0ba804b5a9871633652514a))
* **sdk:** generate audit storage id per parse instead of at import ([bac67af](https://github.com/flipboxlabs/aws-audit/commit/bac67af12b5e5b7d97c97fb7d57fe660a8b79c04)), closes [#76](https://github.com/flipboxlabs/aws-audit/issues/76)

## [1.5.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.4.2...sdk-v1.5.0) (2026-07-27)


### Features

* adding api resource to list items by app and object ([4b04bbe](https://github.com/flipboxlabs/aws-audit/commit/4b04bbe33f9ad733d07383d1ce071db99906f333))
* adding api resource to list items by app and object ([08f7f00](https://github.com/flipboxlabs/aws-audit/commit/08f7f000b2ccbafd47348ff03d9c179c0681dbca))

## [1.4.2](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.4.1...sdk-v1.4.2) (2026-06-24)


### Bug Fixes

* **sdk:** correct audit resource storage ([7f5915a](https://github.com/flipboxlabs/aws-audit/commit/7f5915a91cd821318811dabcadfa0edadb33f178))
* **sdk:** correct audit resource storage ([a294084](https://github.com/flipboxlabs/aws-audit/commit/a29408421f57569e0dba02e95a5d437ccb43763a))

## [1.4.1](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.4.0...sdk-v1.4.1) (2026-06-23)


### Bug Fixes

* allow null audit messages in API responses ([467212d](https://github.com/flipboxlabs/aws-audit/commit/467212dc4734d195bc127c074019979f4f5082b3))
* allow null audit messages in API responses ([dcc9521](https://github.com/flipboxlabs/aws-audit/commit/dcc9521a995019dee0aff642b50bfb8611cf4cad))

## [1.4.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.3.0...sdk-v1.4.0) (2026-06-17)


### Features

* add listByStatus query with GSI2_SS index ([0415aae](https://github.com/flipboxlabs/aws-audit/commit/0415aae47879f363599f68b89064a0832f0a8d10))
* adding audit detail endpoint ([332d2e9](https://github.com/flipboxlabs/aws-audit/commit/332d2e98706b48d945a0ad76bbaa1e974dc778d6))
* adding audit detail endpoint ([f8badd5](https://github.com/flipboxlabs/aws-audit/commit/f8badd518c076a4efe098ed483d533617691423d))


### Bug Fixes

* harden status audit queries ([8988641](https://github.com/flipboxlabs/aws-audit/commit/8988641a0b06ff9e7e451bd4c041eedb827599fb))

## [1.3.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.2.3...sdk-v1.3.0) (2026-04-08)


### Features

* **sdk:** make audit record TTL configurable via ttlSeconds ([a57757b](https://github.com/flipboxlabs/aws-audit/commit/a57757bfa91ab6ecce2b8cfae2758d64b7a1761b))


### Bug Fixes

* format repository TTL helper ([a7fbd61](https://github.com/flipboxlabs/aws-audit/commit/a7fbd610e1b364bd01cdeb042d0b9e07b8c79d9a))
* resolve main conflicts for configurable TTL ([06e24fb](https://github.com/flipboxlabs/aws-audit/commit/06e24fbbd2ff48b879844b80ca8c45d00e215a02))

## [1.2.3](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.2.2...sdk-v1.2.3) (2026-04-06)


### Bug Fixes

* **sdk:** lazy-evaluate process.env.SERVICE in defineAuditConfig ([c12ac4f](https://github.com/flipboxlabs/aws-audit/commit/c12ac4fe4573642eefa3d2f4f8e9e37046b4d9de))
* **sdk:** replace AES-256-CTR pagination tokens with base64url encoding ([916be50](https://github.com/flipboxlabs/aws-audit/commit/916be50f7467bbe76c38a2f60d3c08dad30ad84c))

## [1.2.2](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.2.1...sdk-v1.2.2) (2026-04-06)


### Bug Fixes

* use Array.length instead of Object.keys for storedAudits size check ([2fdd872](https://github.com/flipboxlabs/aws-audit/commit/2fdd872199a86cea43c6b0c545efe8165f2e6832))

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
