<!-- Thanks for contributing to Mera. Please read CONTRIBUTING.md first. -->

## Summary

<!-- What does this PR change and why? Link any related issue. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] Performance improvement
- [ ] Localization / accessibility
- [ ] Documentation
- [ ] Other (describe):

## Checklist

- [ ] `npm run lint` passes with no new warnings
- [ ] `npm test` passes
- [ ] `npx tsc --noEmit` passes
- [ ] New screens follow the `/app` (routing) vs `/components/custom/` (rendering) separation
- [ ] No hardcoded `mera.news` URLs or support emails (use `lib/config/branding.ts` / `.env`)
- [ ] No Mera trademarks introduced in new copy (see TRADEMARK.md)
- [ ] If a GraphQL query/mutation changed: `npm run codegen` was re-run
- [ ] If the WatermelonDB schema changed: a migration was added to `lib/database/migrations.ts`

## Notes for reviewers

<!-- Anything reviewers should focus on, screenshots for UI changes, etc. -->
