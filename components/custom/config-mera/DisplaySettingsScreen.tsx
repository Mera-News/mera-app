import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { setFeedMinimap, useFeedMinimap } from '@/components/custom/feed/feed-view-prefs';
import { TAB_LABEL_KEYS } from '@/components/custom/nav/page-registry';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { type LaunchTab } from '@/lib/navigation/startup-tab';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useStartupTabStore } from '@/lib/stores/startup-tab-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { useAppearanceSetting } from '@/lib/theme/theme-store';
import { useColors, type ThemeMode } from '@/lib/theme/tokens';
import { TEXT_SCALE_LABEL_KEYS, TEXT_SCALE_STEPS, type TextScale } from '@/lib/typography/scale';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTabContentBottomInset } from '@/lib/navigation/tab-bar';

/** Index-aligned with `TEXT_SCALE_STEPS` / `TEXT_SCALE_LABEL_KEYS`, written out
 *  so the keys stay greppable. Settings shows the active one as Display's value. */
export const TEXT_SIZE_LABEL_KEYS = [
  'display.textSizeStepCompact',
  'display.textSizeStepDefault',
  'display.textSizeStepLarge',
  'display.textSizeStepLarger',
] as const;

const STARTUP_TABS: LaunchTab[] = ['feed', 'world', 'library'];

/**
 * Settings > Display (FinalSettings #6, #7): Text (size, preview, one helper
 * line), Visuals (Appearance once the light theme is live, Blur images, Lite
 * mode), Feed (the minimap), When Mera opens (Open on, a small picker), and
 * System check last (owner Y7).
 */
const DisplaySettingsScreen: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomInset = useTabContentBottomInset();

  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const setPerformanceOverride = useDisplayPrefsStore((s) => s.setPerformanceOverride);
  const textScale = useTextScaleStore((s) => s.scale);
  const setTextScale = useTextScaleStore((s) => s.setScale);
  const blurImages = useBlurImagesStore((s) => s.blurImages);
  const setBlurImages = useBlurImagesStore((s) => s.setBlurImages);
  const startupTab = useStartupTabStore((s) => s.startupTab);
  const setStartupTab = useStartupTabStore((s) => s.setStartupTab);
  const minimap = useFeedMinimap();
  const appearance = useAppearanceSetting();
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeIndex = Math.max(0, TEXT_SCALE_STEPS.indexOf(textScale as never));
  const toggle = (value: boolean, onToggle: (on: boolean) => void, testID: string) => (
    <Switch testID={testID} value={value} onToggle={onToggle} size="md" />
  );

  return (
    <View style={{ flex: 1 }}>
      {/* The page background is the very thing this screen configures, so the
          switches below are seen taking effect at once. */}
      <AbstractGradientBackdrop />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <DrillDownHeader title={t('display.screenTitle')} onBack={onBack} backTestID="display-back" />
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: bottomInset }}
        >
          <GroupLabel>{t('display.sectionText')}</GroupLabel>
          <Group>
            <View style={{ padding: 16, gap: 12 }}>
              <Text style={{ color: colors.ink, fontSize: 16 }}>{t('display.textSizeTitle')}</Text>
              {/* One button per step, each 44pt tall: easier to hit than a slider. */}
              <View style={{ flexDirection: 'row', gap: 4 }} accessibilityRole="radiogroup" testID="text-size-options">
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
                      style={{
                        flex: 1,
                        minHeight: 52,
                        borderRadius: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: active ? colors.accent : colors.surface,
                      }}
                    >
                      {/* The glyph scales with the step; the caption does not. */}
                      <Text scaleTier="chrome" style={{ fontSize: Math.round(13 * step), fontWeight: '700', color: active ? colors.onAccent : colors.ink }}>
                        A
                      </Text>
                      <Text size="2xs" scaleTier="chrome" numberOfLines={1} style={{ color: active ? colors.onAccent : colors.ink2 }}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {/* Every Text here follows the scale, so this is the live preview. */}
              <View testID="text-size-preview" style={{ gap: 4 }}>
                <Text size="lg" style={{ color: colors.ink, fontWeight: '600' }}>
                  {t('display.textSizePreviewHeadline')}
                </Text>
                <Text size="sm" style={{ color: colors.ink2 }}>
                  {t('display.textSizePreviewBody')}
                </Text>
              </View>
            </View>
          </Group>
          <View style={{ marginTop: 6 }}>
            <Help>{t('display.textSizeDescription')}</Help>
          </View>

          <GroupLabel>{t('display.sectionVisuals')}</GroupLabel>
          <Group>
            {appearance.live ? (
              <View style={{ padding: 16, gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.ink, fontSize: 16 }}>{t('display.appearanceTitle')}</Text>
                    <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{t('display.appearanceHint')}</Text>
                  </View>
                  <SegmentedControl<ThemeMode>
                    testID="appearance-switch"
                    accessibilityLabel={t('display.appearanceTitle')}
                    value={appearance.mode}
                    onChange={appearance.setMode}
                    options={[
                      { value: 'light', label: t('display.appearanceLight'), icon: 'light-mode' },
                      { value: 'dark', label: t('display.appearanceDark'), icon: 'dark-mode' },
                    ]}
                  />
                </View>
              </View>
            ) : null}
            <Row
              title={t('security.blurImagesTitle')}
              subtitle={t('display.blurHint')}
              trailing={toggle(blurImages, setBlurImages, 'blur-images-switch')}
            />
            {/* Lite mode: On or Off. Until flipped, the phone's own default
                applies (lib/performance/performance-mode.ts). */}
            <Row
              title={t('display.liteModeTitle')}
              subtitle={t('display.liteModeDescription')}
              trailing={toggle(liteMode, (on) => setPerformanceOverride(on ? 'lite' : 'full'), 'lite-mode-switch')}
            />
          </Group>

          <GroupLabel>{t('display.sectionFeed')}</GroupLabel>
          <Group>
            <Row
              title={t('display.minimapTitle')}
              subtitle={t('display.minimapHint')}
              trailing={toggle(minimap, setFeedMinimap, 'feed-minimap-switch')}
            />
          </Group>

          <GroupLabel>{t('display.sectionStartup')}</GroupLabel>
          <Group>
            <Row
              testID="startup-tab-open"
              title={t('display.openOn')}
              value={t(TAB_LABEL_KEYS[startupTab])}
              onPress={() => setPickerOpen(true)}
            />
            <Row
              testID="system-check-open"
              title={t('systemCheck.settingsTitle')}
              subtitle={t('systemCheck.settingsDescription')}
              onPress={() => router.push('/logged-in/system-check' as never)}
            />
          </Group>
        </ScrollView>
      </View>

      <BottomSheet testID="startup-tab-sheet" open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <Group>
          {STARTUP_TABS.map((tab) => {
            const label = t(TAB_LABEL_KEYS[tab]);
            const active = tab === startupTab;
            return (
              <Pressable
                key={tab}
                testID={`startup-tab-${tab}`}
                onPress={() => {
                  setStartupTab(tab);
                  setPickerOpen(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: active, checked: active }}
                accessibilityLabel={t('display.startupTabA11y', { label })}
                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 16 }}
              >
                <Text style={{ flex: 1, color: colors.ink, fontSize: 16 }}>{label}</Text>
                {active ? <MaterialIcons name="check" size={20} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </Group>
      </BottomSheet>
    </View>
  );
};

export default DisplaySettingsScreen;
