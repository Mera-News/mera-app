import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import {
  TEXT_SCALE_LABEL_KEYS,
  TEXT_SCALE_STEPS,
  type TextScale,
} from '@/lib/typography/scale';

import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Index-aligned with `TEXT_SCALE_STEPS` / `TEXT_SCALE_LABEL_KEYS`. Written out
 *  in full rather than assembled from the step name so the keys are greppable
 *  and the i18n key checker can see them. */
const TEXT_SIZE_LABEL_KEYS = [
  'display.textSizeStepCompact',
  'display.textSizeStepDefault',
  'display.textSizeStepLarge',
  'display.textSizeStepLarger',
] as const;

interface DisplaySettingsScreenProps {
  onBack: () => void;
}

/**
 * Settings → Text & Display.
 *
 * WHY THIS SCREEN OWNS BOTH: the text-size control needed a home, and there
 * were already two candidate screens drifting apart — this one on `dev`, and a
 * separate `preferences/appearance.tsx` on the `enabled-light-dark-mode`
 * branch. Adding text size to either would have guaranteed a THIRD competing
 * screen. So this is the one place a reader goes to change how Mera looks: a
 * "Text" section and a "Visuals" section, with room for a theme selector to
 * become a third without another rename.
 *
 * Padding is `px-5` throughout, header included. It used to be `px-4` on the
 * header and `px-5` on the body, so the back arrow sat 4pt left of everything
 * it introduced.
 */
const DisplaySettingsScreen: React.FC<DisplaySettingsScreenProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  const setStaticGradient = useDisplayPrefsStore((s) => s.setStaticGradient);
  const textScale = useTextScaleStore((s) => s.scale);
  const setTextScale = useTextScaleStore((s) => s.setScale);

  const activeIndex = Math.max(0, TEXT_SCALE_STEPS.indexOf(textScale as never));

  return (
    // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
    // below, so it spans the FULL screen including the safe areas — an
    // absolute fill resolves against its parent's CONTENT box, so mounting it
    // inside the padded box left a black strip in the inset.
    <Box className="flex-1">
      {/* Page background. Must be the FIRST child so it paints behind
          everything else on the page — and it is the very thing this screen
          configures, so the toggle below is seen taking effect immediately. */}
      <AbstractGradientBackdrop />

      {/* No opaque fill: the backdrop above is the page background. */}
      <Box className="flex-1" style={{ paddingTop: insets.top }}>
        <HStack className="items-center px-5 py-3" space="sm">
          <Pressable
            testID="display-back"
            onPress={onBack}
            accessibilityRole="button"
            hitSlop={12}
            className="p-1"
          >
            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
          </Pressable>
          <Text size="lg" className="text-white font-semibold">
            {t('display.screenTitle')}
          </Text>
        </HStack>

        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        >
          <VStack className="px-5 pt-2 pb-3">
            <Text size="sm" className="text-gray-400">
              {t('display.screenSubtitle')}
            </Text>
          </VStack>

          {/* ── Text ─────────────────────────────────────────────────────── */}
          <VStack className="px-5">
            <Text size="xs" className="text-gray-500 font-semibold mb-2 uppercase">
              {t('display.sectionText')}
            </Text>

            <VStack className="py-3 px-4 mb-3 border border-gray-700 rounded-lg" space="sm">
              <HStack space="md" className="items-center">
                <MaterialIcons name="format-size" size={24} color="#9ca3af" />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('display.textSizeTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('display.textSizeDescription')}
                  </Text>
                </VStack>
              </HStack>

              {/* Segmented stepper. Each option is its own button with a 44pt
                  minimum touch height — a slider would have been smaller AND
                  harder to hit precisely with five discrete stops. */}
              <HStack
                className="mt-1"
                space="xs"
                accessibilityRole="radiogroup"
                testID="text-size-options"
              >
                {TEXT_SCALE_STEPS.map((step, i) => {
                  const active = i === activeIndex;
                  const label = t(TEXT_SIZE_LABEL_KEYS[i]);
                  return (
                    <Pressable
                      key={String(step)}
                      testID={`text-size-${TEXT_SCALE_LABEL_KEYS[i]}`}
                      onPress={() => setTextScale(step as TextScale)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active, checked: active }}
                      accessibilityLabel={t('display.textSizeA11y', { label })}
                      className={`flex-1 items-center justify-center rounded-md border px-1 ${
                        active
                          ? 'bg-primary-400 border-primary-400'
                          : 'bg-transparent border-gray-700'
                      }`}
                      style={{ minHeight: 44 }}
                    >
                      {/* The GLYPH scales with the step so the control shows
                          what it does; the caption underneath does not, so the
                          five options stay the same width. */}
                      <Text
                        scaleTier="chrome"
                        style={{ fontSize: Math.round(13 * step) }}
                        className={active ? 'text-black font-bold' : 'text-gray-300 font-bold'}
                      >
                        A
                      </Text>
                      <Text
                        size="2xs"
                        scaleTier="chrome"
                        numberOfLines={1}
                        className={active ? 'text-black' : 'text-gray-500'}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </HStack>
            </VStack>

            {/* Live preview. The point of the control is what text looks like,
                and every <Text> below is already subscribed to the scale — so
                this updates as the user taps, without a preview mechanism of
                its own. */}
            <VStack
              testID="text-size-preview"
              className="py-3 px-4 mb-3 border border-gray-700 rounded-lg"
              space="xs"
            >
              <Text size="2xs" className="text-gray-500 uppercase font-semibold">
                {t('display.textSizePreviewLabel')}
              </Text>
              <Text size="lg" className="text-white font-semibold">
                {t('display.textSizePreviewHeadline')}
              </Text>
              <Text size="sm" className="text-gray-400">
                {t('display.textSizePreviewBody')}
              </Text>
            </VStack>

            <Text size="xs" className="text-gray-500 mb-5">
              {t('display.deviceTextSizeHint')}
            </Text>
          </VStack>

          {/* ── Visuals ──────────────────────────────────────────────────── */}
          <VStack className="px-5">
            <Text size="xs" className="text-gray-500 font-semibold mb-2 uppercase">
              {t('display.sectionVisuals')}
            </Text>

            <HStack className="items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg">
              <HStack space="md" className="items-center flex-1 pr-3">
                <MaterialIcons
                  name="gradient"
                  size={24}
                  color={staticGradient ? '#10b981' : '#9ca3af'}
                />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('display.staticGradientTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('display.staticGradientDescription')}
                  </Text>
                </VStack>
              </HStack>

              <Switch
                testID="static-gradient-switch"
                value={staticGradient}
                onToggle={setStaticGradient}
                size="md"
              />
            </HStack>
          </VStack>
        </ScrollView>
      </Box>
    </Box>
  );
};

export default DisplaySettingsScreen;
