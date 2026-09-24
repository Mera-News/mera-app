import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { type StartupTab } from '@/lib/navigation/startup-tab';
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
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';

/**
 * The "Static background" switch is HIDDEN on Android.
 *
 * `AbstractGradientBackdrop` folds Android into the same static path this
 * switch selects (see `isStatic` there), so on Android the switch is already
 * on and cannot be turned off. A visible control that does nothing is worse
 * than an absent one — it invites the user to conclude the setting is broken.
 * The setting itself is untouched: the row is what is hidden, not the store.
 *
 * This gates only the static-gradient ROW, not the whole Visuals section —
 * blur images (folded in from the deleted Security screen) must stay visible
 * on Android, which is the platform the row-level (not section-level) gate
 * exists to protect.
 */
const SHOWS_STATIC_GRADIENT_ROW = Platform.OS !== 'android';

/** Index-aligned with `TEXT_SCALE_STEPS` / `TEXT_SCALE_LABEL_KEYS`. Written out
 *  in full rather than assembled from the step name so the keys are greppable
 *  and the i18n key checker can see them. */
const TEXT_SIZE_LABEL_KEYS = [
  'display.textSizeStepCompact',
  'display.textSizeStepDefault',
  'display.textSizeStepLarge',
  'display.textSizeStepLarger',
] as const;

// Startup-tab options, in the order they're offered. Values are the REAL
// route names under app_container (see lib/navigation/startup-tab.ts for why
// they're inverted from what a user would call them) — labels below borrow
// the shipped tab-bar copy (`tabs.*`) so the wording never drifts from the
// tab bar itself, and the icons mirror app_container/_layout.tsx's Android
// glyphs for the same reason.
const STARTUP_TAB_OPTIONS: {
  tab: StartupTab;
  labelKey: 'tabs.deck' | 'tabs.dashboard' | 'tabs.around';
  icon: keyof typeof MaterialIcons.glyphMap;
}[] = [
  { tab: 'feed', labelKey: 'tabs.deck', icon: 'view-agenda' },
  { tab: 'for_you', labelKey: 'tabs.dashboard', icon: 'dashboard' },
  { tab: 'around', labelKey: 'tabs.around', icon: 'explore' },
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

  const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
  const setStaticGradient = useDisplayPrefsStore((s) => s.setStaticGradient);
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
          {/* Unlike before, this section is NOT gated as a whole: blur images
              (folded in from Security) must survive on Android, which only
              hides the static-gradient row below (see
              SHOWS_STATIC_GRADIENT_ROW's doc). */}
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

            {SHOWS_STATIC_GRADIENT_ROW ? (
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
            ) : null}
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
                {STARTUP_TAB_OPTIONS.map(({ tab, labelKey, icon }) => {
                  const active = tab === startupTab;
                  const label = t(labelKey);
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
