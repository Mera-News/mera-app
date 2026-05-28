# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.10] — Initial public (source-available) release

First publicly available source-available snapshot of the Mera mobile app.

### Added
- `.env.example` documenting every required and optional environment variable for a bring-your-own-backend setup.
- `lib/config/branding.ts` to centralize product URLs and the support email so a fork can rebrand from a single place.
- Community-health docs: `README`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `NOTICE`, and GitHub issue/PR templates.

### Changed
- Configuration (Expo `owner`, EAS project ID, OTA URL, bundle identifiers, Sentry org/project) is now driven through `app.config.js` with environment overrides and committed defaults.
- Sentry no longer sends default PII; a `beforeSend` scrubber strips user data, cookies, and headers before transmission.
- The on-device prompt/result debug dump is hard-gated behind `__DEV__` so it cannot ship in a release build.
- The per-inference-cycle private key is stored in the device keychain (`expo-secure-store`) rather than the local database.

### Security
- See `SECURITY.md` for the vulnerability reporting process and the disclosed E2EE scope.

[Unreleased]: https://github.com/mera-news/mera-app/compare/v1.1.10...HEAD
[1.1.10]: https://github.com/mera-news/mera-app/releases/tag/v1.1.10
