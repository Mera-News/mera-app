/**
 * The raw facts behind one model's Verify result, for someone who came here to check.
 * Hashes wrap instead of scrolling, and stay left to right under Arabic.
 */
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, I18nManager, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { AttestationDetails } from '@/lib/algorithms/attestation-details';
import type { CheckResult, CheckStatus } from '@/lib/algorithms/attestation-verify';
import { hapticLight } from '@/lib/haptics';
import { useColors } from '@/lib/theme/tokens';

/** Technical names, the same in every language. */
const FIXED_LABELS = {
  mrtd: 'MRTD',
  rtmr0: 'RTMR0',
  rtmr1: 'RTMR1',
  rtmr2: 'RTMR2',
  rtmr3: 'RTMR3',
} as const;

const LABEL_KEYS = {
  checkedAt: 'meraProtocol.attestationDetailCheckedAt',
  nonce: 'meraProtocol.attestationDetailNonce',
  encryptionKey: 'meraProtocol.attestationDetailEncryptionKey',
  algorithm: 'meraProtocol.attestationDetailAlgorithm',
  composeHash: 'meraProtocol.attestationDetailComposeHash',
  osImageHash: 'meraProtocol.attestationDetailOsImageHash',
  patchLevel: 'meraProtocol.attestationDetailPatchLevel',
  gpuCount: 'meraProtocol.attestationDetailGpuCount',
  proxyImage: 'meraProtocol.attestationDetailProxyImage',
  composeFile: 'meraProtocol.attestationDetailComposeFile',
  composeTag: 'meraProtocol.attestationDetailComposeTag',
  composeCommit: 'meraProtocol.attestationDetailComposeCommit',
} as const;

/** Display order, which is also the key order of the copied JSON. */
const FIELDS = [
  'checkedAt',
  'nonce',
  'encryptionKey',
  'algorithm',
  'mrtd',
  'rtmr0',
  'rtmr1',
  'rtmr2',
  'rtmr3',
  'composeHash',
  'osImageHash',
  'patchLevel',
  'gpuCount',
  'proxyImage',
  'composeFile',
  'composeTag',
  'composeCommit',
] as const satisfies readonly (keyof AttestationDetails)[];

export const STATUS_LABEL_KEYS = {
  pass: 'meraProtocol.attestationStatusPassed',
  fail: 'meraProtocol.attestationStatusFailed',
  'not-checked': 'meraProtocol.attestationNotCheckedLabel',
} as const satisfies Record<CheckStatus, string>;

interface Props {
  model: string;
  details: AttestationDetails;
  checks: CheckResult[];
}

export function AttestationDetailsCard({ model, details, checks }: Props) {
  const { t } = useTranslation();
  const colors = useColors();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(JSON.stringify({ model, ...details, checks }, null, 2));
    } catch {
      return;
    }
    void hapticLight();
    AccessibilityInfo.announceForAccessibility(t('meraProtocol.attestationCopied'));
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <View
      className="bg-surface-raised rounded-xl"
      style={{ padding: 12, marginTop: 4 }}
      testID={`attestation-details-${model}`}
    >
      <VStack space="sm">
        <Text className="text-ink-2 text-sm font-semibold">{t('meraProtocol.attestationDetailsTitle')}</Text>
        {FIELDS.map(field => {
          const value = details[field];
          if (value === undefined) return null;
          const shown = field === 'patchLevel' ? t(STATUS_LABEL_KEYS[value as CheckStatus]) : String(value);
          return (
            <View key={field} testID={`attestation-detail-${field}`}>
              <Text className="text-ink-3 text-xs">
                {field in FIXED_LABELS
                  ? FIXED_LABELS[field as keyof typeof FIXED_LABELS]
                  : t(LABEL_KEYS[field as keyof typeof LABEL_KEYS])}
              </Text>
              <Text
                selectable
                className="text-ink-2 text-xs"
                style={{ fontVariant: ['tabular-nums'], writingDirection: 'ltr' }}
              >
                {/* An isolate, because Android ignores writingDirection and a digest holds neutral marks. */}
                {I18nManager.isRTL ? `⁦${shown}⁩` : shown}
              </Text>
            </View>
          );
        })}
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          testID={`attestation-copy-${model}`}
          style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>
            {copied ? t('meraProtocol.attestationCopied') : t('meraProtocol.attestationCopyDetails')}
          </Text>
        </Pressable>
      </VStack>
    </View>
  );
}
