// The plan service's generic fallback options carry the literals 'Apply' and
// 'Skip' (GENERIC_OPTIONS, and the guaranteed apply/skip it adds). Those two,
// and only those, render through i18n; plans stored earlier carry the same
// literals, so there is no migration. Everything else is LLM prose and stays on
// the runtime translator.

export function genericOptionLabel(
  opt: { label: string; action: string },
  t: (key: 'optimisationPlan.optionApply' | 'optimisationPlan.optionSkip') => string,
): string | null {
  if (opt.action === 'apply' && opt.label === 'Apply') return t('optimisationPlan.optionApply');
  if (opt.action === 'skip' && opt.label === 'Skip') return t('optimisationPlan.optionSkip');
  return null;
}
