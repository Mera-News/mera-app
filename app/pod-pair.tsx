import { isOnboardingDone } from '@/components/custom/onboarding/onboarding-done';
import { showPodNotice } from '@/components/custom/config-mera/own-services/pod-dialogs';
import { OWN_ROUTES } from '@/components/custom/config-mera/own-services/own-services-copy';
import { showDialog } from '@/lib/dialog';
import { parsePairLink, setPendingPairLink } from '@/lib/own-services/pending-pair-link';
import { podHost, podPaired, podState } from '@/lib/own-services/pod-state';
import { readLocalIdentityStateSettled } from '@/lib/security/launch-route';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { t } from 'i18next';
import { useEffect, useRef } from 'react';

/** The pairing link's landing. It draws nothing: it either says why it cannot go on, or hands the link to the pod page. */
export default function PodPairLink() {
  const { u, c } = useLocalSearchParams<{ u?: string; c?: string }>();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void (async () => {
      const leave = () => router.replace('/' as Href);
      const parsed = parsePairLink(`meraapp://pod-pair?u=${encodeURIComponent(u ?? '')}&c=${encodeURIComponent(c ?? '')}`);
      const ready = (await readLocalIdentityStateSettled()) === 'present' && (await isOnboardingDone());
      if (!ready) {
        await showPodNotice(t, t('ownServices.pod.notSetUp'));
        return leave();
      }
      if (!parsed.ok) {
        await showPodNotice(t, t('ownServices.pod.linkInvalid'));
        return leave();
      }
      await podState.hydrate().catch(() => undefined);
      if (podPaired()) {
        await showPodNotice(t, t('ownServices.pod.alreadyPaired', { host: podHost() ?? '' }));
        return leave();
      }
      // Opened cold, the mode may not be read yet: read it now, never assume the private cloud.
      await useMeraProtocolStore.getState().hydrateFromDb();
      if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice) {
        const go = await showDialog({
          title: t('ownServices.pod.title'),
          body: t('ownServices.onDevice.line'),
          confirmLabel: t('ownServices.onDevice.button'),
          cancelLabel: t('common.cancel'),
        });
        return go ? router.navigate(OWN_ROUTES.onDevice as Href) : leave();
      }
      setPendingPairLink(parsed);
      router.replace(OWN_ROUTES.pod as Href);
    })();
  }, [u, c]);

  return null;
}
