// Not called globally: a test that asserts on copy calls this first.
export async function initI18nEn(): Promise<void> {
  const i18n = require('@/lib/i18n').default;
  await i18n.changeLanguage('en');
}
