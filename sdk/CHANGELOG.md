# Changelog

## [2.2.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v2.1.0...sdk-v2.2.0) (2026-11-20)


### Features

* log a rerun's outcome as an attempt of the audit it reruns ([51f5566](https://github.com/flipboxlabs/aws-audit/commit/51f5566ba6ce8b0056c7fcfde03d6b42891bc5ea))
* log a rerun's outcome as an attempt of the audit it reruns ([34a4667](https://github.com/flipboxlabs/aws-audit/commit/34a4667ce13638183d6f6df7a5b65056c552effb)), closes [#158](https://github.com/flipboxlabs/aws-audit/issues/158)
* tag a rerun's attempt, and match reruns as handlers leave their audits ([3c75696](https://github.com/flipboxlabs/aws-audit/commit/3c75696681f7248aaf6d8681cc39827528f76f9f))


### Bug Fixes

* keep reruns working if PutEvents refuses the audit, and link reruns predictably ([59b6bd7](https://github.com/flipboxlabs/aws-audit/commit/59b6bd7fde4b66c2c204af4dc16c79d33bac1bea))

## [2.1.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v2.0.0...sdk-v2.1.0) (2026-11-20)


### Features

* rerun an event on the bus it was put on ([9b6e475](https://github.com/flipboxlabs/aws-audit/commit/9b6e47595f2e41fa8a6927f7bec13bd081c2a816)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)


### Bug Fixes

* decide an event-less attempt's rerunable flag from the event the audit kept ([67f2d7c](https://github.com/flipboxlabs/aws-audit/commit/67f2d7cec6badd2fd4a2b29d52a80f1ea0141143)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* keep a PutEvents entry's bus in normalizeEventBridgetInput ([f41c74d](https://github.com/flipboxlabs/aws-audit/commit/f41c74d105c4548632829088c35de4913dcc13dc)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* let logged audits set rerunable, and keep a failure's flag without an event ([5062201](https://github.com/flipboxlabs/aws-audit/commit/50622016354fa67c9cfa0d488600c89f3bd654c5)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* make SDK-logged audits rerunable, on the bus their event came from ([fa3504e](https://github.com/flipboxlabs/aws-audit/commit/fa3504efc58cf2e6112f2771dbb5c6dfd7975ca3))
* store the rerunable flag from what an upsert logged, without a follow-up write ([37540cd](https://github.com/flipboxlabs/aws-audit/commit/37540cd3d1ecc98c0878c95e6c0b5cfb5dd16639)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* store whether an audit is rerunable, and only rerun a failure's event ([3d63ad5](https://github.com/flipboxlabs/aws-audit/commit/3d63ad532ccad8ef398c9e8b446181963a3118f9)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)

## [2.0.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.8.0...sdk-v2.0.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* defineAuditConfig and ConfigLayerConstruct take `apps: { [app]: resourceTypes[] }` in place of `apps` and `resourceTypes` lists; the layer's audit-config.json and .mjs export only `apps`, as that map. GET /config answers `apps` as the map, without `resourceTypes`. Rust: AuditConfig::new takes (app, types) pairs, and aws-audit-http's resource_type takes the app.
* the SDK, the CDK constructs and the Lambdas read and write the new table only. Deploy the new version, then copy the old table's audits with `aws-audit-migrate`; the old table is retained. Listings return summaries (no context, event, error or attempts).

### Features

* **cdk:** record audits from Rust Lambdas with the aws-audit crate ([83476f0](https://github.com/flipboxlabs/aws-audit/commit/83476f08e9803996f46e369db331533d3885d66d)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* list each app's resource types in the config ([f70a2e1](https://github.com/flipboxlabs/aws-audit/commit/f70a2e14661bc840408bc1661faab3cd35416968)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** add aws-audit-migrate to copy 1.x audits into the v2 table ([5d3bfd7](https://github.com/flipboxlabs/aws-audit/commit/5d3bfd7cddadd471a9859f6898db957bd95bf240)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** throw InvalidResourceFilterError for an incomplete resource filter ([1ea022a](https://github.com/flipboxlabs/aws-audit/commit/1ea022a7991f0d444a97233e1acadf0ad6188f45)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* store audits in a v2 table keyed by multi-attribute indexes ([b4fe9fa](https://github.com/flipboxlabs/aws-audit/commit/b4fe9fad05d2a7e94f8b303304733016ecd0c2dd))


### Bug Fixes

* **cdk:** treat an audit's empty trace as none in the aws-audit crate ([8d9c018](https://github.com/flipboxlabs/aws-audit/commit/8d9c018fa059b851c1323781f196ad59a18a17db)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* copy the audit as stored, and drop a stale resourceId on retry ([08d8216](https://github.com/flipboxlabs/aws-audit/commit/08d821650b145f0704f4e802ed4cf9e8663ba799)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* delete a related copy under the resource a retry targets ([1daaa19](https://github.com/flipboxlabs/aws-audit/commit/1daaa193bf8d9be5a81440844b8d072c4884adc2)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* drop an earlier target's scopes when a retry changes the target ([ee2fe3c](https://github.com/flipboxlabs/aws-audit/commit/ee2fe3c3fef0cbc21634c5db562ddd4a864e03e0)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* escape each part of the table's keys and scopes ([79e9ad6](https://github.com/flipboxlabs/aws-audit/commit/79e9ad614458b6bc9123afbd18a737ce32467dcb)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* keep empty index keys out of the writers and the migration ([4e7e68b](https://github.com/flipboxlabs/aws-audit/commit/4e7e68bba84451cac375c4e19876ab4431d36457)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* keep related copies from the merged audit when a retry overlaps the migration ([b2a477d](https://github.com/flipboxlabs/aws-audit/commit/b2a477d4bd4933d0f5c2b8f108bf2eac1b5988fc)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* keep the latest upsert's related copies when upserts overlap ([b54c1e1](https://github.com/flipboxlabs/aws-audit/commit/b54c1e18b000b0c45389de052f11ef2ae0ff2341)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* mark related copies, and refuse the reserved tenant in Rust listings ([94d2967](https://github.com/flipboxlabs/aws-audit/commit/94d2967a5be9fb4060d1f278274fbf48003dc741)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **migrate:** mark merged audits, read audits by their attempts, check concurrency ([4fb93f2](https://github.com/flipboxlabs/aws-audit/commit/4fb93f2207b95901bee74ece140c1f843dde04e4)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **migrate:** merge audits retried since the deploy, and normalise timestamps ([ba8f0ae](https://github.com/flipboxlabs/aws-audit/commit/ba8f0ae72b0fa3630563aba02c4d91fddce10d11)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* project scopes for resource filters, and keep copies out of ByStatus ([1557c10](https://github.com/flipboxlabs/aws-audit/commit/1557c10c04fa0befb5f1d0fde38bb275ffc77fcd)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* refuse an apps config that isn't a map of resource type arrays ([f247ea2](https://github.com/flipboxlabs/aws-audit/commit/f247ea2c591ee2366263e27b7e262c6a74652587)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove every replaced target's scope on the latest retry ([ec7a5e7](https://github.com/flipboxlabs/aws-audit/commit/ec7a5e7ff29e926a3c3836c22e39c775f012dd35)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove only the replaced target's scope on a retry ([272fa9c](https://github.com/flipboxlabs/aws-audit/commit/272fa9c10939a7d7a08c60eadb053d429a2c9c01)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove the trace index attributes when a retry clears the trace ([6064e31](https://github.com/flipboxlabs/aws-audit/commit/6064e31eb71b2dcf6da67a3b201173dabcefe732)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** accept only table names, not ARNs, for a migration ([4e9b0b0](https://github.com/flipboxlabs/aws-audit/commit/4e9b0b0604aafb719c6765ca3c08ae25b2ed9cb9)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** guard migrate() against one table and bound all its writes ([e8f34ad](https://github.com/flipboxlabs/aws-audit/commit/e8f34ad8f6c3b2655d45a8597d305a0bd46e1a5f)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** keep getItem's resource type narrowed to its app's ([0cd20d7](https://github.com/flipboxlabs/aws-audit/commit/0cd20d798133f39f8629d5a371583926c640a5c0)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** make the migration's copies independent of scan order ([ec7c11f](https://github.com/flipboxlabs/aws-audit/commit/ec7c11fe41b877188aa427f00a37c7d6ba47141a)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** migrate copies as the released 1.x SDKs stored them ([8e50a3e](https://github.com/flipboxlabs/aws-audit/commit/8e50a3e4aacc9b8c23e36a182736448c595ffb42)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** migrate copies with their audit's createdAt, and audits whose id holds a # ([b4b8f26](https://github.com/flipboxlabs/aws-audit/commit/b4b8f26866ef2b1a0d72f79d6a6dc51a5d64e0c5)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** migrate pre-1.4.2 copies, and merge retried audits whole ([bac7249](https://github.com/flipboxlabs/aws-audit/commit/bac72498a0d2ab0ff08e0abc0dc503f6e21c9a33)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** read the X-Ray trace id per invocation, and tolerate non-event SQS bodies ([c4011cd](https://github.com/flipboxlabs/aws-audit/commit/c4011cd8d2db642a88337358a0d7fdf6167a9dad)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** stop a failed migration's writes before it rejects ([44cff6d](https://github.com/flipboxlabs/aws-audit/commit/44cff6dfb9cfeffc98374925fde5bae947663f2b)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* skip related copies whose keys DynamoDB can't store ([b134077](https://github.com/flipboxlabs/aws-audit/commit/b134077731080414f3b6a56097ac23a78139d258)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* store empty strings as such, so an upsert reads back valid ([e1b1ea8](https://github.com/flipboxlabs/aws-audit/commit/e1b1ea8cc57357bb65b8512994cd1950d01c3270)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* write one related copy per resource and add to an audit's scopes ([69c7507](https://github.com/flipboxlabs/aws-audit/commit/69c7507180cb52651351474e8c9b7ced96aee507)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)

## [1.8.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.7.0...sdk-v1.8.0) (2026-11-17)


### Features

* **cdk:** shared Rust HTTP layer; GET /config and GET /status/{status} on Rust ([c27dd35](https://github.com/flipboxlabs/aws-audit/commit/c27dd35369542cd6ad35d87e0bb2c0d32a2495b1))


### Bug Fixes

* **sdk:** publish an audit's message as an optional string ([7c7120a](https://github.com/flipboxlabs/aws-audit/commit/7c7120a95484aa673e2606a04792c27a9655b81e)), closes [#138](https://github.com/flipboxlabs/aws-audit/issues/138)

## [1.7.0](https://github.com/flipboxlabs/aws-audit/compare/sdk-v1.6.2...sdk-v1.7.0) (2026-11-14)


### Features

* **rust:** DynamoDB repository, EventBridge publisher and audit service (phase 2b) ([d0b419c](https://github.com/flipboxlabs/aws-audit/commit/d0b419c80916421c8934c4eb1d3feba7458ce621))

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
