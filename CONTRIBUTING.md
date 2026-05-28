# Contributing to Mera

Thank you for your interest in contributing to Mera.

## Source-Available, Not Open Source

This project is governed by the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use requires a separate written agreement with Mera News B.V. Contributions you submit become subject to the same license (see "License of Contributions" below).

`"private": true` in `package.json` is intentional. It prevents accidental `npm publish` but does not restrict source distribution. The PolyForm Noncommercial License 1.0.0 in `LICENSE.md` governs what you may do with the source code.

## What We Accept

- Bug fixes that are reproducible and include clear reproduction steps
- Performance improvements with measurable impact
- Localization corrections to existing locale files (`lib/locales/`)
- Accessibility improvements
- Documentation fixes

For larger feature PRs, **open an issue for discussion before building**. This avoids wasted effort if the feature does not fit the project roadmap or would require backend changes in the private `mera-server` repository.

## What We Do Not Accept

- PRs that remove, modify, or bypass `LICENSE.md`, `TRADEMARK.md`, or the `"license"` field in `package.json`
- PRs that re-introduce hardcoded `mera.news` URLs, `com.mera.news` bundle IDs, or `contact@mera.news` addresses (these must use `lib/config/branding.ts` and `.env.example` instead)
- PRs that introduce new Mera trademarks into copy or assets in a way that would require trademark permission from Mera News B.V. (see [TRADEMARK.md](TRADEMARK.md))
- New server-side features that require backend changes without a paired description of the required backend API contract
- Dependency additions without a license review (run `npx license-checker --summary` and check compatibility with PolyForm Noncommercial)

## Development Setup

See the [README Quick Start](README.md#quick-start) for setup instructions. Note that this app requires a BYO backend — see [Backend Requirements](README.md#backend-requirements-byo-backend).

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

By submitting a pull request you agree that:

1. Your contribution is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
2. You have the right to make the contribution (you own it or have permission from the owner).
3. You understand that contributions do not grant you any rights to the Mera trademarks.

## Contact

- **Security vulnerabilities**: see [SECURITY.md](SECURITY.md) — email security@meranews.app. Do not open public issues for vulnerabilities.
- **Licensing questions**: legal@meranews.app
