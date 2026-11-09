/**
 * "Verify attestation" — an inline expand row for the Mera Protocol screen.
 *
 * Renders the result of a REAL Intel TDX quote and NVIDIA GPU verification (see
 * `lib/algorithms/attestation-verify.ts`), one row per check.
 *
 * Two rules this component exists to hold:
 *
 *  1. `not-checked` never renders as a green tick. A check the app skips, like
 *     TCB currency, gets a distinct grey "remove" icon and a "not checked"
 *     label, because a security screen that quietly omits what it skipped is
 *     worse than one that admits it.
 *  2. The summary line derives from the WEAKEST check, so the header can never
 *     read "Verified" while the expanded list contains something unchecked.
 *
 * Each tap checks both models, and one failing never hides the other. A card under
 * each shows the raw values for anyone who came here to check them.
 *
 * FAIL-OPEN: nothing here gates inference. A failure is displayed, not
 * enforced. The notice text says so rather than letting the user infer a
 * protection that isn't there yet.
 */
import { useColors } from '@/lib/theme/tokens';
import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { HStack } from '@/components/ui/hstack';
import { AttestationDetailsCard, STATUS_LABEL_KEYS } from '@/components/custom/config-mera/AttestationDetailsCard';
import { Group, Row } from '@/components/custom/you/rows';
import { VStack } from '@/components/ui/vstack';
import { Text } from '@/components/ui/text';
import {
  fetchAttestationForVerification,
  fetchComposeFile,
  generateAttestationNonce,
} from '@/lib/e2ee/e2ee-service';
import { checkDeployedSoftware } from '@/lib/algorithms/deployed-software';
import { attestationDetails, type AttestationDetails } from '@/lib/algorithms/attestation-details';
import { verifyAttestation, type CheckId, type VerificationReport } from '@/lib/algorithms/attestation-verify';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
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
  'deployed-software',
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
  'deployed-software': 'meraProtocol.attestationCheckDeployedSoftware',
} as const satisfies Record<CheckId, string>;

// shortcut: deduped while both lanes share one model (see lib/llm/constants.ts).
const MODELS = [...new Set([BIG_MODEL, SMALL_MODEL])];

type ModelResult =
  | { model: string; report: VerificationReport; details: AttestationDetails }
  | { model: string; report: null };

type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; results: ModelResult[] }
  | { phase: 'error' };

async function verifyModel(model: string): Promise<ModelResult> {
  try {
    // A fresh nonce per tap — this is what makes the freshness check real,
    // and it deliberately bypasses every cache in the path.
    const nonce = generateAttestationNonce();
    const { attestation } = await fetchAttestationForVerification(model, nonce);
    const quoteHex = attestation.intel_quote ?? '';
    const deployedSoftware = await checkDeployedSoftware(
      {
        composeManagerAttestation: attestation.compose_manager_attestation,
        modelQuoteHex: quoteHex,
        modelName: model,
        expectedNonce: nonce,
      },
      fetchComposeFile,
    );
    const report = verifyAttestation({
      quoteHex,
      signingPublicKey: attestation.signing_public_key ?? '',
      signingAlgo: attestation.signing_algo,
      expectedNonce: nonce,
      hasGpuPayload: Boolean(attestation.nvidia_payload),
      nvidiaAttestation: attestation.nvidia_attestation,
      deployedSoftware,
    });
    const details = attestationDetails({
      checkedAt: new Date(),
      nonce,
      signingPublicKey: attestation.signing_public_key,
      signingAlgo: attestation.signing_algo,
      quoteHex,
      info: attestation.info,
      report,
      proxy: deployedSoftware.proxy,
    });
    return { model, report, details };
  } catch (e) {
    // A fetch failure is NOT a verification failure — showing it as one
    // would train users to ignore red. It gets its own state.
    logger.debug('[attestation] verification fetch failed', { model, error: String(e) });
    return { model, report: null };
  }
}

/** The weakest result across models: a model that couldn't be fetched can't read as a pass. */
function weakestVerdict(results: ModelResult[]): VerificationReport['verdict'] {
  if (results.some(r => r.report?.verdict === 'failed')) return 'failed';
  return results.every(r => r.report?.verdict === 'verified') ? 'verified' : 'incomplete';
}


function ModelSection({ result }: { result: ModelResult }) {
  const { t } = useTranslation();
  const colors = useColors();
  const { model, report } = result;

  return (
    <VStack space="sm" testID={`attestation-model-${model}`}>
      <Text selectable className="text-ink-2 text-sm font-semibold">
        {model}
      </Text>
      {!report && (
        <Text className="text-ink-3 text-sm" testID="attestation-model-error">
          {t('meraProtocol.attestationModelError')}
        </Text>
      )}
      {report &&
        CHECK_ORDER.map(id => {
          const check = report.checks.find(c => c.id === id);
          if (!check) return null;
          const isPass = check.status === 'pass';
          const isFail = check.status === 'fail';
          const label = t(CHECK_LABEL_KEYS[id]);
          return (
            <View key={id}>
              <HStack
                accessible
                accessibilityLabel={`${label}, ${t(STATUS_LABEL_KEYS[check.status])}`}
                space="sm"
                className="items-start"
                testID={`attestation-check-${id}`}
              >
                <MaterialIcons
                  // `remove` (not `check-circle`) for not-checked — the
                  // whole point is that it must not read as a pass.
                  name={isPass ? 'check-circle' : isFail ? 'cancel' : 'remove'}
                  size={16}
                  color={isPass ? colors.positive : isFail ? colors.negative : colors.ink3}
                  style={{ marginTop: 2 }}
                />
                <Text className="text-ink-2 text-sm flex-1">
                  {label}
                  {check.status === 'not-checked'
                    ? ` · ${t('meraProtocol.attestationNotCheckedLabel')}`
                    : ''}
                </Text>
              </HStack>
              {!isPass && (
                <Text
                  selectable
                  className="text-ink-3 text-xs"
                  style={{ marginStart: 24 }}
                  testID={`attestation-check-detail-${id}`}
                >
                  {check.detail}
                </Text>
              )}
            </View>
          );
        })}
      {result.report && (
        <AttestationDetailsCard model={model} details={result.details} checks={result.report.checks} />
      )}
    </VStack>
  );
}

export function AttestationVerificationRow() {
  const { t } = useTranslation();
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<RunState>({ phase: 'idle' });

  const run = useCallback(async () => {
    setState({ phase: 'running' });
    setExpanded(true);
    const results = await Promise.all(MODELS.map(verifyModel));
    setState(results.some(r => r.report) ? { phase: 'done', results } : { phase: 'error' });
  }, []);

  const verdict = state.phase === 'done' ? weakestVerdict(state.results) : null;
  const anyPassed = (id: CheckId) =>
    state.phase === 'done' &&
    state.results.some(r => r.report?.checks.find(c => c.id === id)?.status === 'pass');

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

  // One row in the page's grouped look; what the check proves is in the modes help card.
  return (
    <View style={{ paddingHorizontal: 14, marginBottom: 8 }} testID="mera-protocol-attestation">
      <Group>
        <Pressable
          onPress={() => setExpanded(prev => !prev)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${t('meraProtocol.attestationTitle')}, ${summaryText}`}
          testID="mera-protocol-attestation-toggle"
        >
          <Row
            title={t('meraProtocol.attestationTitle')}
            subtitle={summaryText}
            trailing={
              <MaterialIcons
                name={expanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                size={24}
                color={colors.ink3}
              />
            }
          />
        </Pressable>

        {expanded && (
          <VStack space="sm" style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            {state.phase === 'done' &&
              state.results.map(result => <ModelSection key={result.model} result={result} />)}

            {state.phase === 'done' && (
              <Text className="text-ink-3 text-xs mt-2">
                {verdict === 'failed'
                  ? t('meraProtocol.attestationVerdictFailedDetail')
                  : t('meraProtocol.attestationVerdictIncompleteDetail')}
              </Text>
            )}

            {anyPassed('gpu-attestation') && (
                <Text className="text-ink-3 text-xs mt-2" testID="attestation-gpu-notice">
                  {t('meraProtocol.attestationGpuNotice')}
                </Text>
              )}

            {anyPassed('deployed-software') && (
                <Text className="text-ink-3 text-xs mt-2" testID="attestation-deployed-software-notice">
                  {t('meraProtocol.attestationDeployedSoftwareNotice')}
                </Text>
              )}

            {/* Scope disclosure. This row checks one machine per model at one
                moment, and each model has a session fallback it doesn't check,
                so a pass here does NOT mean every cloud request went to a
                verified enclave. Saying "the cloud AI" without this would
                over-claim in exactly the way the rest of this feature exists
                to avoid. */}
            {state.phase === 'done' && (
              <Text className="text-ink-3 text-xs mt-2" testID="attestation-scope-notice">
                {t('meraProtocol.attestationScopeNotice')}
              </Text>
            )}

            <Text className="text-ink-3 text-xs mt-2">
              {t('meraProtocol.attestationFailOpenNotice')}
            </Text>

            <Pressable
              onPress={run}
              disabled={state.phase === 'running'}
              accessibilityRole="button"
              accessibilityState={{ disabled: state.phase === 'running' }}
              testID="mera-protocol-attestation-run"
              style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
            >
              <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>
                {state.phase === 'running'
                  ? t('meraProtocol.attestationVerifying')
                  : state.phase === 'idle'
                    ? t('meraProtocol.attestationVerifyButton')
                    : t('meraProtocol.attestationRerun')}
              </Text>
            </Pressable>
          </VStack>
        )}
      </Group>
    </View>
  );
}
