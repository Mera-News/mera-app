# Contributing to Mera

Thank you for your interest in contributing to Mera.

## Proprietary — Not Open Source

This project is proprietary and confidential. All rights are reserved by Mera Labs B.V. (KVK 42077437); see [LICENSE.md](LICENSE.md). No license to use, copy, modify, or distribute the source code is granted. Contributions are accepted only from people authorized in writing by Mera Labs B.V., and any contribution is assigned to Mera Labs B.V. (see "License of Contributions" below).

`"private": true` in `package.json` is intentional — it prevents accidental `npm publish`. The proprietary terms in `LICENSE.md` govern what you may do with the source code.

## What We Accept

- Bug fixes that are reproducible and include clear reproduction steps
- Performance improvements with measurable impact
- Localization corrections to existing locale files (`lib/locales/`)
- Accessibility improvements
- Documentation fixes

For larger feature PRs, **open an issue for discussion before building**. This avoids wasted effort if the feature does not fit the project roadmap or would require changes to the auth/GraphQL backend (the reference `mera-server`) or the inference gateway (`mera-inference-gateway`) — both proprietary and not published.

## What We Do Not Accept

- PRs that remove, modify, or bypass `LICENSE.md`, `TRADEMARK.md`, or the `"license"` field in `package.json`
- PRs that re-introduce hardcoded `mera.news` URLs, `com.mera.news` bundle IDs, or `contact@mera.news` addresses (these must use `lib/config/branding.ts` and `.env.example` instead)
- PRs that introduce new Mera trademarks into copy or assets in a way that would require trademark permission from Mera Labs B.V. (see [TRADEMARK.md](TRADEMARK.md))
- New server-side features that require backend changes without a paired description of the required backend API contract
- Dependency additions that skip the rules in [Dependencies](#dependencies) below

## Dependencies

- **Do not add any new dependency without discussion first.** This is a hard rule — open an issue before adding a package.
- **Never add packages that request sensitive device permissions** — camera, photo library, location, contacts, microphone, etc. Mera does not use them, and adding one changes our privacy posture and store-review footprint. If a feature seems to need one, raise it for discussion before writing any code.
- **License review**: run `npx license-checker --summary` and confirm every new dependency permits commercial, proprietary redistribution.

## Development Setup

See the [README Quick Start](README.md#quick-start) for setup instructions. This app requires the Mera backend services — the auth/GraphQL server (`mera-server`) and the inference gateway (`mera-inference-gateway`) — which are proprietary and not published.

Day-to-day commands (npm scripts, Expo, EAS build/submit, OTA) live in [COMMANDS.md](COMMANDS.md).

**Testing**: use development builds. Build the `development` profile (`eas build --profile development`) and run against the custom dev client — not Expo Go, which cannot load the native modules this app depends on.

## Versioning & Releases

- **Always update the version in `app.json` and `package.json` together.** They must never drift apart. The runtime version policy is `appVersion`, so the `app.json` `version` is what native builds and OTA-update compatibility are keyed on — a mismatch silently breaks update targeting.
- **Follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)**:
  - `PATCH` (`1.2.0` → `1.2.1`) — bug fixes, no behavior change.
  - `MINOR` (`1.2.0` → `1.3.0`) — new features, backward compatible.
  - `MAJOR` (`1.2.0` → `2.0.0`) — breaking changes.
- **Only bump the version when publishing a new build to the App Store / Play Store.** A store release is the only thing that increments the version.
- **Never bump the version for an OTA update.** OTA updates (`eas update`) ship to installs that already share the current `appVersion` — changing the version would cut those updates off from the very builds they target. Ship OTA patches against the existing version; leave `app.json`/`package.json` untouched.

See the version-bump checklist in [COMMANDS.md](COMMANDS.md) for the full release flow.

## Code Style

- **ESLint**: run `npm run lint` before committing. The CI pipeline enforces this.
- **TypeScript**: strict mode. Do not add `// @ts-ignore` or `any` types without a comment explaining why.
- **NativeWind + Gluestack UI v4**: all UI components use these libraries. Refer to the [Gluestack UI v4 docs](https://v4.gluestack.io/ui/docs/components/) before making UI changes.
- **Routing vs rendering**: `/app` files contain routing only (no JSX rendering, no state). All rendering lives in `/components/custom/{feature}/`. See `CLAUDE.md` for details.
- **State management**: Zustand for shared/global/persisted state. React `useState`/`useRef` for local/ephemeral state.

## Pull Request Checklist

Before submitting a PR, confirm:

- [ ] `npm run lint` passes with no new warnings
- [ ] `npm test` passes
- [ ] New screens follow the `/app` (routing) / `/components/custom/` (rendering) separation
- [ ] No hardcoded `mera.news` URLs or `contact@mera.news` addresses (use `lib/config/branding.ts`)
- [ ] No Mera trademarks introduced in new copy (see [TRADEMARK.md](TRADEMARK.md))
- [ ] If a GraphQL query or mutation was added or changed: `npm run codegen` was re-run and `lib/generated/graphql-types.ts` is updated
- [ ] If the WatermelonDB schema was changed: a new migration was added to `lib/database/migrations.ts`

## License of Contributions

> **Read this before you open a PR.** Mera is **not** a standard open-source project (it is not MIT-style). It is proprietary and commercial — see [LICENSE.md](LICENSE.md). Submitting a PR does **not** obligate us to use it, and it is not treated as open-source.

**By opening a pull request you authorize Mera Labs B.V. to use, modify, and ship your contribution in our commercial app — royalty-free — and you assign it to us.** Concretely:

1. You assign to Mera Labs B.V. all right, title, and interest in and to your contribution, which becomes part of the proprietary Software governed by [LICENSE.md](LICENSE.md). To the extent any right cannot be assigned, you grant Mera Labs B.V. a perpetual, worldwide, royalty-free, irrevocable license to use it for any purpose, including in our commercial products.
2. **We may or may not use your code.** We are under no obligation to merge, ship, or otherwise use any contribution, and we may modify it freely if we do.
3. You have the right to make the contribution (you own it or have written permission from the owner).
4. The contribution does not grant you any license to the Software or any rights to the Mera trademarks.

The admin may ask you to sign a Contributor License Agreement (CLA) form confirming the above before your PR can be merged.

**If you do not agree to these terms, do not open a PR.** Instead, [open an issue](https://github.com/Mera-News/mera-app/issues) describing your request or idea, and our team will take it from there.

## Contact

- **Security vulnerabilities**: see [SECURITY.md](SECURITY.md) — email security@meranews.app. Do not open public issues for vulnerabilities.
- **Licensing questions**: legal@meranews.app
