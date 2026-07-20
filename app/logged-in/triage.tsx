// Routing only — the triage one-card review screen.
//
// No entry point by design (product decision 2026-07-20) — the For-You triage
// entry pill was removed in favour of the Feed/Stories/Saved sub-tabs. This
// route is kept for future re-exposure; do not delete.
import TriageScreen from '@/components/custom/triage/TriageScreen';

export default function TriageRoute() {
  return <TriageScreen />;
}
