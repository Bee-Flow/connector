# Changelog

All notable changes to the Bee Flow Nextcloud connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Nextcloud App Store reads the entry whose heading matches `<version>` in `appinfo/info.xml`.

## [0.1.0] - 2026-05-08

### Added
- Initial release. ExApp manifest, AppAPI HMAC signature verifier, `/heartbeat` `/init` `/enabled` lifecycle endpoints, JWT-bearer forward proxy to the hosted Bee Flow SaaS, and embedded React SPA served from the connector container.
- Compatibility: Nextcloud 31–34, AppAPI 3.2+.
