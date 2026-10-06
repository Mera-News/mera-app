import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { type LaunchTab } from '@/lib/navigation/startup-tab';
import { TAB_LABEL_KEYS } from '@/components/custom/nav/page-registry';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useStartupTabStore } from '@/lib/stores/startup-tab-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import {
  TEXT_SCALE_LABEL_KEYS,
  TEXT_SCALE_STEPS,
  type TextScale,
} from '@/lib/typography/scale';

import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';


/** Index-aligned with `TEXT_SCALE_STEPS` / `TEXT_SCALE_LABEL_KEYS`. Written out
 *  in full rather than assembled from the step name so the keys are greppable
 *  and the i18n key checker can see them. */
const TEXT_SIZE_LABEL_KEYS = [
  'display.textSizeStepCompact',
  'display.textSizeStepDefault',
  'display.textSizeStepLarge',
  'display.textSizeStepLarger',
] as const;

// Open on launch: Feed, World or Library (L4's LaunchTab). Labels are the tab
// bar's own keys (TAB_LABEL_KEYS) so the wording never drifts from the bar,
// and the icons are the tabs' Android glyphs for the same reason.
const STARTUP_TAB_OPTIONS: {
  tab: LaunchTab;
  icon: keyof typeof MaterialIcons.glyphMap;
}[] = [
  { tab: 'feed', icon: 'view-agenda' },
  { tab: 'world', icon: 'public' },
  { tab: 'library', icon: 'bookmark' },
];

interface DisplaySettingsScreenProps {
  onBack: () => void;
}

/**
 * Settings → Display.
 *
 * WHY THIS SCREEN OWNS ALL OF THIS: the text-size control needed a home, and
 * there were already two candidate screens drifting apart — this one on
 * `dev`, and a separate `preferences/appearance.tsx` on the
 * `enabled-light-dark-mode` branch. Adding text size to either would have
 * guaranteed a THIRD competing screen. This is the one place a reader goes to
 * change how Mera looks and how it opens: Text, Visuals, Startup tab. The PIN
 * lock used to live here too and moved to its own Security group directly in
 * Settings (SecuritySettingsSection), where people look for it.
 *
 * Padding is `px-5` throughout, header included. It used to be `px-4` on the
 * header and `px-5` on the body, so the back arrow sat 4pt left of everything
 * it introduced.
 */
const DisplaySettingsScreen: React.FC<DisplaySettingsScreenProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const setPerformanceOverride = useDisplayPrefsStore((s) => s.setPerformanceOverride);
  const textScale = useTextScaleStore((s) => s.scale);
  const setTextScale = useTextScaleStore((s) => s.setScale);
  const blurImages = useBlurImagesStore((s) => s.blurImages);
  const setBlurImages = useBlurImagesStore((s) => s.setBlurImages);
  const startupTab = useStartupTabStore((s) => s.startupTab);
  const setStartupTab = useStartupTabStore((s) => s.setStartupTab);

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
        <DrillDownHeader title={t('display.screenTitle')} onBack={onBack} backTestID="display-back" />

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
                  name="blur-on"
                  size={24}
                  color={blurImages ? '#10b981' : '#9ca3af'}
                />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('security.blurImagesTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('security.blurImagesDescription')}
                  </Text>
                </VStack>
              </HStack>

              <Switch testID="blur-images-switch" value={blurImages} onToggle={setBlurImages} size="md" />
            </HStack>

            {/* Lite mode: On or Off, nothing else (owner: an "Automatic" choice
                was hard to understand). Until the reader flips it, the phone's
                own default applies (lib/performance/performance-mode.ts);
                after that their choice sticks. */}
            <HStack className="items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg">
              <HStack space="md" className="items-center flex-1 pr-3">
                <MaterialIcons name="speed" size={24} color={liteMode ? '#10b981' : '#9ca3af'} />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('display.liteModeTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('display.liteModeDescription')}
                  </Text>
                </VStack>
              </HStack>

              <Switch
                testID="lite-mode-switch"
                value={liteMode}
                onToggle={(on: boolean) => setPerformanceOverride(on ? 'lite' : 'full')}
                size="md"
              />
            </HStack>

            <Pressable
              testID="system-check-open"
              onPress={() => router.push('/logged-in/system-check' as any)}
              accessibilityRole="button"
              className="py-3 px-4 mb-3 border border-gray-700 rounded-lg"
            >
              <HStack space="md" className="items-center">
                <MaterialIcons name="fact-check" size={24} color="#9ca3af" />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('systemCheck.settingsTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('systemCheck.settingsDescription')}
                  </Text>
                </VStack>
                <MaterialIcons name="chevron-right" size={24} color="#6b7280" />
              </HStack>
            </Pressable>
          </VStack>

          {/* ── Startup tab ──────────────────────────────────────────────── */}
          <VStack className="px-5">
            <Text size="xs" className="text-gray-500 font-semibold mb-2 uppercase">
              {t('display.sectionStartup')}
            </Text>

            <VStack className="py-3 px-4 mb-3 border border-gray-700 rounded-lg" space="sm">
              <HStack space="md" className="items-center">
                <MaterialIcons name="open-in-new" size={24} color="#9ca3af" />
                <VStack className="flex-1">
                  <Text className="text-base text-white">{t('display.startupTabTitle')}</Text>
                  <Text size="sm" className="text-gray-400 mt-0.5">
                    {t('display.startupTabDescription')}
                  </Text>
                </VStack>
              </HStack>

              <HStack
                className="mt-1"
                space="xs"
                accessibilityRole="radiogroup"
                testID="startup-tab-options"
              >
                {STARTUP_TAB_OPTIONS.map(({ tab, icon }) => {
                  const active = tab === startupTab;
                  const label = t(TAB_LABEL_KEYS[tab]);
                  return (
                    <Pressable
                      key={tab}
                      testID={`startup-tab-${tab}`}
                      onPress={() => setStartupTab(tab)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active, checked: active }}
                      accessibilityLabel={t('display.startupTabA11y', { label })}
                      className={`flex-1 items-center justify-center rounded-md border px-1 py-2 ${
                        active
                          ? 'bg-primary-400 border-primary-400'
                          : 'bg-transparent border-gray-700'
                      }`}
                      style={{ minHeight: 44 }}
                    >
                      <MaterialIcons name={icon} size={18} color={active ? '#000000' : '#d1d5db'} />
                      <Text
                        size="2xs"
                        scaleTier="chrome"
                        numberOfLines={1}
                        className={active ? 'text-black mt-0.5' : 'text-gray-500 mt-0.5'}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </HStack>
            </VStack>
          </VStack>
        </ScrollView>
      </Box>
    </Box>
  );
};

export default DisplaySettingsScreen;
