# Changelog

## [2.1.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v2.0.0...cdk-v2.1.0) (2026-11-20)


### Features

* rerun an event on the bus it was put on ([9b6e475](https://github.com/flipboxlabs/aws-audit/commit/9b6e47595f2e41fa8a6927f7bec13bd081c2a816)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)


### Bug Fixes

* decide an event-less attempt's rerunable flag from the event the audit kept ([67f2d7c](https://github.com/flipboxlabs/aws-audit/commit/67f2d7cec6badd2fd4a2b29d52a80f1ea0141143)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* let logged audits set rerunable, and keep a failure's flag without an event ([5062201](https://github.com/flipboxlabs/aws-audit/commit/50622016354fa67c9cfa0d488600c89f3bd654c5)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* make SDK-logged audits rerunable, on the bus their event came from ([fa3504e](https://github.com/flipboxlabs/aws-audit/commit/fa3504efc58cf2e6112f2771dbb5c6dfd7975ca3))
* rerun an audit that recorded an event without a rerunable flag ([86548a3](https://github.com/flipboxlabs/aws-audit/commit/86548a3d3a270ab7d621e9927f8f32dffe4d45d4)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* store the rerunable flag from what an upsert logged, without a follow-up write ([37540cd](https://github.com/flipboxlabs/aws-audit/commit/37540cd3d1ecc98c0878c95e6c0b5cfb5dd16639)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)
* store whether an audit is rerunable, and only rerun a failure's event ([3d63ad5](https://github.com/flipboxlabs/aws-audit/commit/3d63ad532ccad8ef398c9e8b446181963a3118f9)), closes [#152](https://github.com/flipboxlabs/aws-audit/issues/152)

## [2.0.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.10.1...cdk-v2.0.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* defineAuditConfig and ConfigLayerConstruct take `apps: { [app]: resourceTypes[] }` in place of `apps` and `resourceTypes` lists; the layer's audit-config.json and .mjs export only `apps`, as that map. GET /config answers `apps` as the map, without `resourceTypes`. Rust: AuditConfig::new takes (app, types) pairs, and aws-audit-http's resource_type takes the app.
* the SDK, the CDK constructs and the Lambdas read and write the new table only. Deploy the new version, then copy the old table's audits with `aws-audit-migrate`; the old table is retained. Listings return summaries (no context, event, error or attempts).

### Features

* **cdk:** handle an SQS batch's messages concurrently in process_batch ([a439e75](https://github.com/flipboxlabs/aws-audit/commit/a439e75652002c59160dd04de7b9e40b9d39849d)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **cdk:** record audits from Rust Lambdas with the aws-audit crate ([83476f0](https://github.com/flipboxlabs/aws-audit/commit/83476f08e9803996f46e369db331533d3885d66d)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* list each app's resource types in the config ([f70a2e1](https://github.com/flipboxlabs/aws-audit/commit/f70a2e14661bc840408bc1661faab3cd35416968)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
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
* project scopes for resource filters, and keep copies out of ByStatus ([1557c10](https://github.com/flipboxlabs/aws-audit/commit/1557c10c04fa0befb5f1d0fde38bb275ffc77fcd)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* refuse an apps config that isn't a map of resource type arrays ([f247ea2](https://github.com/flipboxlabs/aws-audit/commit/f247ea2c591ee2366263e27b7e262c6a74652587)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove every replaced target's scope on the latest retry ([ec7a5e7](https://github.com/flipboxlabs/aws-audit/commit/ec7a5e7ff29e926a3c3836c22e39c775f012dd35)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove only the replaced target's scope on a retry ([272fa9c](https://github.com/flipboxlabs/aws-audit/commit/272fa9c10939a7d7a08c60eadb053d429a2c9c01)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* remove the trace index attributes when a retry clears the trace ([6064e31](https://github.com/flipboxlabs/aws-audit/commit/6064e31eb71b2dcf6da67a3b201173dabcefe732)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** accept only table names, not ARNs, for a migration ([4e9b0b0](https://github.com/flipboxlabs/aws-audit/commit/4e9b0b0604aafb719c6765ca3c08ae25b2ed9cb9)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** make the migration's copies independent of scan order ([ec7c11f](https://github.com/flipboxlabs/aws-audit/commit/ec7c11fe41b877188aa427f00a37c7d6ba47141a)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** migrate copies as the released 1.x SDKs stored them ([8e50a3e](https://github.com/flipboxlabs/aws-audit/commit/8e50a3e4aacc9b8c23e36a182736448c595ffb42)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** migrate pre-1.4.2 copies, and merge retried audits whole ([bac7249](https://github.com/flipboxlabs/aws-audit/commit/bac72498a0d2ab0ff08e0abc0dc503f6e21c9a33)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* **sdk:** stop a failed migration's writes before it rejects ([44cff6d](https://github.com/flipboxlabs/aws-audit/commit/44cff6dfb9cfeffc98374925fde5bae947663f2b)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* skip related copies whose keys DynamoDB can't store ([b134077](https://github.com/flipboxlabs/aws-audit/commit/b134077731080414f3b6a56097ac23a78139d258)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* store empty strings as such, so an upsert reads back valid ([e1b1ea8](https://github.com/flipboxlabs/aws-audit/commit/e1b1ea8cc57357bb65b8512994cd1950d01c3270)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)
* write one related copy per resource and add to an audit's scopes ([69c7507](https://github.com/flipboxlabs/aws-audit/commit/69c7507180cb52651351474e8c9b7ced96aee507)), closes [#149](https://github.com/flipboxlabs/aws-audit/issues/149)

## [1.10.1](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.10.0...cdk-v1.10.1) (2026-11-17)


### Bug Fixes

* **cdk:** remove the Node handlers and the dependencies only they used ([a7aee0a](https://github.com/flipboxlabs/aws-audit/commit/a7aee0aaf927355b792da2b0a8300118811cc576)), closes [#144](https://github.com/flipboxlabs/aws-audit/issues/144) [#93](https://github.com/flipboxlabs/aws-audit/issues/93)
* **cdk:** remove the Node handlers and their dependencies ([c161319](https://github.com/flipboxlabs/aws-audit/commit/c16131964a8c7acc6ad8fdfc9d95510bebaa3888))

## [1.10.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.9.0...cdk-v1.10.0) (2026-11-17)


### Features

* **cdk:** add the Rust pieces for audit detail and rerun ([7b99bf9](https://github.com/flipboxlabs/aws-audit/commit/7b99bf9485e3204cd7b5c334fbbd03918aebf4f2))
* **cdk:** run the trace, objects and rerun Lambdas on Rust ([658a8d5](https://github.com/flipboxlabs/aws-audit/commit/658a8d5fb8f81539541df1c40cc97dce040ee912)), closes [#141](https://github.com/flipboxlabs/aws-audit/issues/141) [#93](https://github.com/flipboxlabs/aws-audit/issues/93)
* **cdk:** trace, objects and rerun Lambdas on Rust ([0a3c1e0](https://github.com/flipboxlabs/aws-audit/commit/0a3c1e04bc5ad46e4c5c7f8d8bb213671baa04fd))


### Bug Fixes

* **cdk:** filter GET /trace/{trace} by filter[resourceType] ([5f00dc5](https://github.com/flipboxlabs/aws-audit/commit/5f00dc5109cc0c8fc45f8e5cd54ffbc910d14719)), closes [#107](https://github.com/flipboxlabs/aws-audit/issues/107) [#141](https://github.com/flipboxlabs/aws-audit/issues/141)
* **cdk:** name every Rust log field in camelCase ([48e6ca4](https://github.com/flipboxlabs/aws-audit/commit/48e6ca45354b82a32aab2560affb8643f7d71328))

## [1.9.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.8.0...cdk-v1.9.0) (2026-11-17)


### Features

* **cdk:** add Rust building blocks for the REST Lambdas ([08d5984](https://github.com/flipboxlabs/aws-audit/commit/08d5984d7fb39b7448896c5e7d867d1594abebe2))
* **cdk:** run GET /config and GET /status/{status} on Rust ([94069cc](https://github.com/flipboxlabs/aws-audit/commit/94069cccf2e05357d6d3e4e97de550ce7601bdc9)), closes [#138](https://github.com/flipboxlabs/aws-audit/issues/138) [#93](https://github.com/flipboxlabs/aws-audit/issues/93)
* **cdk:** shared Rust HTTP layer; GET /config and GET /status/{status} on Rust ([c27dd35](https://github.com/flipboxlabs/aws-audit/commit/c27dd35369542cd6ad35d87e0bb2c0d32a2495b1))

## [1.8.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.7.0...cdk-v1.8.0) (2026-11-16)


### Features

* **cdk:** run the subscription Lambda on Rust ([136f31f](https://github.com/flipboxlabs/aws-audit/commit/136f31f2114138c990e3864a68f501376cc72e1c)), closes [#135](https://github.com/flipboxlabs/aws-audit/issues/135) [#93](https://github.com/flipboxlabs/aws-audit/issues/93)
* **cdk:** run the subscription Lambda on Rust ([#93](https://github.com/flipboxlabs/aws-audit/issues/93) phase 4) ([ee8b562](https://github.com/flipboxlabs/aws-audit/commit/ee8b56289db8a59c09a805953db329249669c088))


### Bug Fixes

* **cdk:** keep the requestId on Rust log lines and log errors with their causes ([2623717](https://github.com/flipboxlabs/aws-audit/commit/26237174f3e0df2098b9f7c312d2752b7e6822b9)), closes [#135](https://github.com/flipboxlabs/aws-audit/issues/135)
* **cdk:** skip control messages and non-JSON lines in the subscription, and record its contract ([34ddf49](https://github.com/flipboxlabs/aws-audit/commit/34ddf4943f28c74ecd69edd4fb87bfbc65f5b881)), closes [#135](https://github.com/flipboxlabs/aws-audit/issues/135)

## [1.7.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.6...cdk-v1.7.0) (2026-11-16)


### Features

* **cdk:** add RustFunctionFactory for prebuilt Rust Lambdas ([da3cbed](https://github.com/flipboxlabs/aws-audit/commit/da3cbed2d5b831f3d85c9ab7df20fbba1a2c4964)), closes [#131](https://github.com/flipboxlabs/aws-audit/issues/131)
* **cdk:** write the audit config as JSON in the config layer for Rust Lambdas ([0e0f1c6](https://github.com/flipboxlabs/aws-audit/commit/0e0f1c60f0311199d311cea669008e51a9ee3020)), closes [#131](https://github.com/flipboxlabs/aws-audit/issues/131)

## [1.6.6](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.5...cdk-v1.6.6) (2026-11-14)


### Bug Fixes

* **cdk:** answer REST errors consistently and reject bad pagination with 422 ([66435e0](https://github.com/flipboxlabs/aws-audit/commit/66435e044745bd083131a0d650373e24c4b7a677)), closes [#124](https://github.com/flipboxlabs/aws-audit/issues/124)

## [1.6.5](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.4...cdk-v1.6.5) (2026-11-13)


### Bug Fixes

* **sdk:** include related-resource audits in filtered trace and status listings ([9a68373](https://github.com/flipboxlabs/aws-audit/commit/9a68373990a88fe16240c93860969fb37df5ab58))

## [1.6.4](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.3...cdk-v1.6.4) (2026-11-13)


### Bug Fixes

* **cdk:** answer 404 when the audit doesn't belong to {item} ([7f1d3b4](https://github.com/flipboxlabs/aws-audit/commit/7f1d3b4da152d35930c128419bc3ff7b01080e20))
* **cdk:** answer 404 when the audit doesn't belong to {item} ([f08bbaf](https://github.com/flipboxlabs/aws-audit/commit/f08bbaff91daca25e38858782f6296a2636da99c)), closes [#105](https://github.com/flipboxlabs/aws-audit/issues/105)
* **cdk:** keep audits without a target id reachable ([af4a6d7](https://github.com/flipboxlabs/aws-audit/commit/af4a6d73e18b7a0558cdd9b872f5e392a2aab7bb))
* **cdk:** load the audit config layer from audit-config.mjs ([13c7af4](https://github.com/flipboxlabs/aws-audit/commit/13c7af4b9bb4c226572bcdfbc50346b8d9438830))
* **cdk:** mark the audit config layer as an ES module package ([8132434](https://github.com/flipboxlabs/aws-audit/commit/813243487bda32a199a922a032a4f5b0ad67072a))
* **cdk:** mark the audit config layer as an ES module package ([d88c521](https://github.com/flipboxlabs/aws-audit/commit/d88c5210fd1cb75e30ef144f26648a7fcd3a80dd)), closes [#114](https://github.com/flipboxlabs/aws-audit/issues/114)

## [1.6.3](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.2...cdk-v1.6.3) (2026-11-13)


### Bug Fixes

* answer 404 when the requested audit doesn't exist ([d6b5ba0](https://github.com/flipboxlabs/aws-audit/commit/d6b5ba0cdbdf5806896567e235fc5996988e1b18))
* **cdk:** answer 404 when the requested audit doesn't exist ([4100b89](https://github.com/flipboxlabs/aws-audit/commit/4100b891ce7ca4969ba1b899f0861fc40d847ec0)), closes [#90](https://github.com/flipboxlabs/aws-audit/issues/90)

## [1.6.2](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.1...cdk-v1.6.2) (2026-11-13)


### Bug Fixes

* **cdk:** answer 500 when rerun can't re-send the event ([18bb1df](https://github.com/flipboxlabs/aws-audit/commit/18bb1df802998a395af9c2a7f5e1a5e837ebd6ed))

## [1.6.1](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.6.0...cdk-v1.6.1) (2026-11-13)


### Bug Fixes

* **cdk:** send the stored event detail as-is when rerunning an audit ([716edcd](https://github.com/flipboxlabs/aws-audit/commit/716edcd2c7073c00b661ee12810650cfa061c215))
* **cdk:** send the stored event detail as-is when rerunning an audit ([44adaa6](https://github.com/flipboxlabs/aws-audit/commit/44adaa60fbff256cef020b74b24d3897328add9a)), closes [#87](https://github.com/flipboxlabs/aws-audit/issues/87)
* **sdk:** return the trace an audit was written with ([edb85ee](https://github.com/flipboxlabs/aws-audit/commit/edb85eead353f0f55e49db1d38329b8014b2abcd))

## [1.6.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.5.0...cdk-v1.6.0) (2026-11-13)


### Features

* **cdk:** add GET /config REST route to discover a deployment's configuration ([b3ce45d](https://github.com/flipboxlabs/aws-audit/commit/b3ce45dfbb8ed855d01f185c22db3a38f9efe534))
* **cdk:** add GET /config REST route to discover a deployment's configuration ([72ea005](https://github.com/flipboxlabs/aws-audit/commit/72ea005579c37f72336dc0655ba29d15332d0187)), closes [#82](https://github.com/flipboxlabs/aws-audit/issues/82)

## [1.5.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.4.0...cdk-v1.5.0) (2026-11-12)


### Features

* **cdk:** run audit Lambdas on the Node.js 24 runtime ([99f6c9b](https://github.com/flipboxlabs/aws-audit/commit/99f6c9b71f09c1f772213d77f840d8e01b8a821f))
* **cdk:** run audit Lambdas on the Node.js 24 runtime ([0bc2462](https://github.com/flipboxlabs/aws-audit/commit/0bc246242034f0dc17aaac4ee67f77e0ce13a3b8))

## [1.4.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.3.1...cdk-v1.4.0) (2026-07-27)


### Features

* adding api resource to list items by app and object ([4b04bbe](https://github.com/flipboxlabs/aws-audit/commit/4b04bbe33f9ad733d07383d1ce071db99906f333))
* adding api resource to list items by app and object ([08f7f00](https://github.com/flipboxlabs/aws-audit/commit/08f7f000b2ccbafd47348ff03d9c179c0681dbca))

## [1.3.1](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.3.0...cdk-v1.3.1) (2026-06-23)


### Bug Fixes

* allow null audit messages in API responses ([467212d](https://github.com/flipboxlabs/aws-audit/commit/467212dc4734d195bc127c074019979f4f5082b3))
* allow null audit messages in API responses ([dcc9521](https://github.com/flipboxlabs/aws-audit/commit/dcc9521a995019dee0aff642b50bfb8611cf4cad))

## [1.3.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.2.2...cdk-v1.3.0) (2026-06-17)


### Features

* add listByStatus query with GSI2_SS index ([0415aae](https://github.com/flipboxlabs/aws-audit/commit/0415aae47879f363599f68b89064a0832f0a8d10))
* adding audit detail endpoint ([332d2e9](https://github.com/flipboxlabs/aws-audit/commit/332d2e98706b48d945a0ad76bbaa1e974dc778d6))
* adding audit detail endpoint ([f8badd5](https://github.com/flipboxlabs/aws-audit/commit/f8badd518c076a4efe098ed483d533617691423d))


### Bug Fixes

* harden status audit queries ([8988641](https://github.com/flipboxlabs/aws-audit/commit/8988641a0b06ff9e7e451bd4c041eedb827599fb))

## [1.2.2](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.2.1...cdk-v1.2.2) (2026-04-08)


### Bug Fixes

* resolve main conflicts for configurable TTL ([06e24fb](https://github.com/flipboxlabs/aws-audit/commit/06e24fbbd2ff48b879844b80ca8c45d00e215a02))

## [1.2.1](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.2.0...cdk-v1.2.1) (2026-04-06)


### Bug Fixes

* format CHANGELOG.md to pass vp check ([cb634de](https://github.com/flipboxlabs/aws-audit/commit/cb634de7fc81caf27a511166204afdfffbd6b7d0))

## [1.2.0](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.5...cdk-v1.2.0) (2026-04-04)


### Features

* migrate to Vite+ toolchain and add CI workflow ([21c24f6](https://github.com/flipboxlabs/aws-audit/commit/21c24f6b1f37eb94e84d3b29d988fb242906d94d))

## [1.1.5](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.4...cdk-v1.1.5) (2026-04-02)

### Bug Fixes

- issues w/ imports ([93908cc](https://github.com/flipboxlabs/aws-audit/commit/93908cccc5bee655673e0f06975537dbadeafdb2))

## [1.1.4](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.3...cdk-v1.1.4) (2026-04-02)

### Bug Fixes

- simplify export ([4f8b726](https://github.com/flipboxlabs/aws-audit/commit/4f8b72669f7ea2cd7401e8e5e855c9a06a2673f2))

## [1.1.3](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.2...cdk-v1.1.3) (2026-04-02)

### Bug Fixes

- improper export on builds ([aad029d](https://github.com/flipboxlabs/aws-audit/commit/aad029d1656544ed6df1862491a71a29dadd0485))

## [1.1.2](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.1...cdk-v1.1.2) (2026-04-01)

### Bug Fixes

- type issues when running cdk functions ([4eca8c0](https://github.com/flipboxlabs/aws-audit/commit/4eca8c0e9496c54199e0297d3871fbb2a936dca4))

## [1.1.1](https://github.com/flipboxlabs/aws-audit/compare/cdk-v1.1.0...cdk-v1.1.1) (2026-03-31)

### Bug Fixes

- bump docs ([2a5f2cc](https://github.com/flipboxlabs/aws-audit/commit/2a5f2cc38cab11ea3146bc9b8ffd7b61676f39d8))
- sync package versions to 1.1.0 ([172d74e](https://github.com/flipboxlabs/aws-audit/commit/172d74ecc2b8f29a3ee8467a3b8a76313e8cf20f))

## 1.0.0 (2026-03-31)

### Features

- initial commit ([8f0fb0f](https://github.com/flipboxlabs/aws-audit/commit/8f0fb0f95ff9a71059747ed0893998d8c428b963))
