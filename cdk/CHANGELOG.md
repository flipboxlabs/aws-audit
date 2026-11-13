# Changelog

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
