# design-sync notes

- The target project ("Mera Design System") is hand-authored: its components are web lookalikes of the RN
  components, built against the old dark-only palette. No `_ds_sync.json` anchor exists, so a full sync re-verifies
  everything and would replace `components/`, `guidelines/`, `tokens/` and `fonts/`. The owner chose tokens-only
  over a full sync: confirm with them before any full sync into this project.
- Theme colours live in `tokens/theme.css` as `--color-*`, mirrored by hand from `themeCssVars()` and `COLORS` in
  `lib/theme/tokens.ts`; light is `data-theme="light"`. Re-copy them whenever `tokens.ts` changes.
- mera-app is React Native with no Storybook and no web component build (`react-native-web` is installed, but the
  components import stores, WatermelonDB and native modules). Spike whether they bundle for web before planning a
  full package-shape sync.
- The project readme still lists the old tabs (Feed / Dashboard / Explore / Profile / Settings); the app now has
  four tabs. Not fixed in the tokens-only pass.
