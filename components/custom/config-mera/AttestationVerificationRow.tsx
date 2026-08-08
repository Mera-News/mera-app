/**
 * "Verify attestation" — an inline expand row for the Mera Protocol screen.
 *
 * Renders the result of a REAL Intel TDX quote verification (see
 * `lib/e2ee/attestation-verify.ts`), one row per check.
 *
 * Two rules this component exists to hold:
 *
 *  1. `not-checked` never renders as a green tick. TCB currency and GPU
 *     attestation are genuinely not verified, and a security screen that
 *     quietly omits what it skipped is worse than one that admits it. They get
 *     a distinct grey "remove" icon and a "not checked" label.
 *  2. The summary line derives from the WEAKEST check, so the header can never
 *     read "Verified" while the expanded list contains something unchecked.
 *
 * FAIL-OPEN: nothing here gates inference. A failure is displayed, not
 * enforced. The notice text says so rather than letting the user infer a
 * protection that isn't there yet.
 */
import React, { useCallback, useState } from 'react';
import { Pressable } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import {
  fetchAttestationForVerification,
  generateAttestationNonce,
} from '@/lib/e2ee/e2ee-service';
import { verifyAttestation, type CheckId, type VerificationReport } from '@/lib/e2ee/attestation-verify';
import { SMALL_MODEL } from '@/lib/llm/constants';
import logger from '@/lib/logger';

/** Stable display order — most security-relevant first, unchecked items last
 *  so the honest gaps are visible rather than buried mid-list. */
export const CHECK_ORDER: CheckId[] = [
  'report-data-key',
  'freshness-nonce',
  'quote-signature',
  'attestation-key-binding',
  'qe-report-signature',
  'pck-chain',
  'root-ca-pin',
  'quote-structure',
  'signing-algo',
  'tcb-status',
  'gpu-attestation',
];

// `as const satisfies` rather than a `Record<CheckId, string>` annotation: the
// annotation widens every value to `string`, which is precisely what forced a
// cast at the `t()` call site. This keeps the literal types (so the keys are
// checked against the generated en.json union) AND still fails the build if a
// CheckId is ever added without a label.
export const CHECK_LABEL_KEYS = {
  'report-data-key': 'meraProtocol.attestationCheckReportDataKey',
  'freshness-nonce': 'meraProtocol.attestationCheckFreshness',
  'quote-signature': 'meraProtocol.attestationCheckQuoteSignature',
  'attestation-key-binding': 'meraProtocol.attestationCheckAttestationKeyBinding',
  'qe-report-signature': 'meraProtocol.attestationCheckQeReportSignature',
  'pck-chain': 'meraProtocol.attestationCheckPckChain',
  'root-ca-pin': 'meraProtocol.attestationCheckRootCaPin',
  'quote-structure': 'meraProtocol.attestationCheckQuoteStructure',
  'signing-algo': 'meraProtocol.attestationCheckSigningAlgo',
  'tcb-status': 'meraProtocol.attestationCheckTcbStatus',
  'gpu-attestation': 'meraProtocol.attestationCheckGpuAttestation',
} as const satisfies Record<CheckId, string>;

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; report: VerificationReport }
  | { phase: 'error' };


export function AttestationVerificationRow() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<RunState>({ phase: 'idle' });

  const run = useCallback(async () => {
    setState({ phase: 'running' });
    setExpanded(true);
    try {
      // A fresh nonce per tap — this is what makes the freshness check real,
      // and it deliberately bypasses every cache in the path.
      const nonce = generateAttestationNonce();
      const { attestation } = await fetchAttestationForVerification(SMALL_MODEL, nonce);
      const report = verifyAttestation({
        quoteHex: attestation.intel_quote ?? '',
        signingPublicKey: attestation.signing_public_key ?? '',
        signingAlgo: attestation.signing_algo,
        expectedNonce: nonce,
        hasGpuPayload: Boolean(attestation.nvidia_payload),
      });
      setState({ phase: 'done', report });
    } catch (e) {
      // A fetch failure is NOT a verification failure — showing it as one
      // would train users to ignore red. It gets its own state.
      logger.debug('[attestation] verification fetch failed', { error: String(e) });
      setState({ phase: 'error' });
    }
  }, []);

  const verdict = state.phase === 'done' ? state.report.verdict : null;

  const summaryText =
    state.phase === 'running'
      ? t('meraProtocol.attestationVerifying')
      : state.phase === 'error'
        ? t('meraProtocol.attestationError')
        : verdict === 'failed'
          ? t('meraProtocol.attestationVerdictFailed')
          : verdict === 'incomplete'
            ? t('meraProtocol.attestationVerdictIncomplete')
            : verdict === 'verified'
              ? t('meraProtocol.attestationVerdictVerified')
              : t('meraProtocol.attestationNotRunYet');

  const summaryColor =
    verdict === 'failed' || state.phase === 'error'
      ? '#ef4444'
      : verdict === 'verified'
        ? '#10b981'
        : verdict === 'incomplete'
          ? '#eab308'
          : '#9ca3af';

  return (
    <Box className="px-5 mb-6" testID="mera-protocol-attestation">
      <Box className="p-4 rounded-lg border border-primary-400">
        <Pressable
          onPress={() => setExpanded(prev => !prev)}
          testID="mera-protocol-attestation-toggle"
        >
          <HStack space="md" className="items-start">
            <MaterialIcons name="verified-user" size={24} color={summaryColor} style={{ marginTop: 2 }} />
            <VStack className="flex-1">
              <Text className="text-typography-400 text-base font-semibold mb-1">
                {t('meraProtocol.attestationTitle')}
              </Text>
              <Text className="text-typography-400 text-sm leading-5">
                {t('meraProtocol.attestationSubtitle')}
              </Text>
              <Text className="text-sm mt-1 font-semibold" style={{ color: summaryColor }}>
                {summaryText}
              </Text>
            </VStack>
            <MaterialIcons
              name={expanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
              size={24}
              color="#9ca3af"
              style={{ marginTop: 2 }}
            />
          </HStack>
        </Pressable>

        {expanded && (
          <VStack space="sm" className="mt-4 pt-4 border-t" style={{ borderTopColor: '#374151' }}>
            {state.phase === 'done' &&
              CHECK_ORDER.map(id => {
                const check = state.report.checks.find(c => c.id === id);
                if (!check) return null;
                const isPass = check.status === 'pass';
                const isFail = check.status === 'fail';
                return (
                  <HStack key={id} space="sm" className="items-start" testID={`attestation-check-${id}`}>
                    <MaterialIcons
                      // `remove` (not `check-circle`) for not-checked — the
                      // whole point is that it must not read as a pass.
                      name={isPass ? 'check-circle' : isFail ? 'cancel' : 'remove'}
                      size={16}
                      color={isPass ? '#10b981' : isFail ? '#ef4444' : '#6b7280'}
                      style={{ marginTop: 2 }}
                    />
                    <Text className="text-typography-400 text-sm flex-1">
                      {t(CHECK_LABEL_KEYS[id])}
                      {check.status === 'not-checked'
                        ? ` — ${t('meraProtocol.attestationNotCheckedLabel')}`
                        : ''}
                    </Text>
                  </HStack>
                );
              })}

            {state.phase === 'done' && (
              <Text className="text-typography-500 text-xs mt-2">
                {verdict === 'failed'
                  ? t('meraProtocol.attestationVerdictFailedDetail')
                  : t('meraProtocol.attestationVerdictIncompleteDetail')}
              </Text>
            )}

            {/* Scope disclosure. This row attests ONE model — the scoring
                model. Chat runs on a different model, and each has a session
                fallback, so a pass here does NOT mean every cloud request went
                to a verified enclave. Saying "the cloud AI" without this would
                over-claim in exactly the way the rest of this feature exists
                to avoid. */}
            {state.phase === 'done' && (
              <Text className="text-typography-500 text-xs mt-2" testID="attestation-scope-notice">
                {t('meraProtocol.attestationModelLabel')}: {SMALL_MODEL}
                {'\n'}
                {t('meraProtocol.attestationScopeNotice')}
              </Text>
            )}

            <Text className="text-typography-500 text-xs mt-2">
              {t('meraProtocol.attestationFailOpenNotice')}
            </Text>

            <Pressable
              onPress={run}
              disabled={state.phase === 'running'}
              testID="mera-protocol-attestation-run"
              className="mt-2"
            >
              <Text className="text-primary-400 text-sm font-semibold">
                {state.phase === 'running'
                  ? t('meraProtocol.attestationVerifying')
                  : state.phase === 'idle'
                    ? t('meraProtocol.attestationVerifyButton')
                    : t('meraProtocol.attestationRerun')}
              </Text>
            </Pressable>
          </VStack>
        )}
      </Box>
    </Box>
  );
}
