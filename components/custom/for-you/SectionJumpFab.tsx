import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** One jumpable section entry. */
export interface SectionEntry {
  id: string;
  /** Display label (fact title, or the "Also for you" string). */
  label: string;
  /** Story count in the section — shown in the menu. */
  count: number;
}

interface SectionJumpFabProps {
  sections: SectionEntry[];
  /** The section currently at the top of the viewport (drives "next"). */
  currentSectionId: string | null;
  onJumpToSection: (sectionId: string) => void;
  onJumpToTop: () => void;
}

/**
 * Wide pill FAB pinned bottom-center above the tab bar. The pill shows
 * "↓ ⟨next section⟩" and scrolls to the next section on tap; a trailing list
 * button opens a floating menu of every section (+ a "Top" entry) with story
 * counts. When there is no next section (list at its end) only the menu button
 * shows.
 */
const SectionJumpFab: React.FC<SectionJumpFabProps> = ({
  sections,
  currentSectionId,
  onJumpToSection,
  onJumpToTop,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);

  const nextSection = useMemo(() => {
    if (sections.length === 0) return null;
    const idx = sections.findIndex((s) => s.id === currentSectionId);
    // Unknown current → offer the first section; otherwise the one after it.
    const nextIdx = idx < 0 ? 0 : idx + 1;
    return nextIdx < sections.length ? sections[nextIdx] : null;
  }, [sections, currentSectionId]);

  if (sections.length === 0) return null;

  const bottom = insets.bottom + TAB_BAR_HEIGHT + 12;

  const jump = (id: string) => {
    setMenuOpen(false);
    onJumpToSection(id);
  };
  const jumpTop = () => {
    setMenuOpen(false);
    onJumpToTop();
  };

  return (
    <>
      <Box className="absolute left-0 right-0 items-center" style={{ bottom }} pointerEvents="box-none">
        <HStack space="sm" className="items-center" pointerEvents="box-none">
          {nextSection && (
            <Pressable
              onPress={() => jump(nextSection.id)}
              accessibilityRole="button"
              accessibilityLabel={t('feed.jumpToSection')}
              className="flex-row items-center rounded-full bg-primary-400 px-4 py-2.5"
              style={{ maxWidth: width * 0.65 }}
            >
              <MaterialIcons name="arrow-downward" size={16} color="#000000" style={{ marginRight: 6 }} />
              <Text size="sm" numberOfLines={1} className="text-black font-semibold flex-shrink">
                {nextSection.label}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('feed.jumpToSection')}
            className="h-11 w-11 items-center justify-center rounded-full border border-primary-500 bg-black"
          >
            <MaterialIcons name="format-list-bulleted" size={20} color={ACCENT} />
          </Pressable>
        </HStack>
      </Box>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable className="flex-1" onPress={() => setMenuOpen(false)}>
          <Box
            className="absolute right-4 rounded-2xl border border-gray-800 bg-gray-950 py-2"
            style={{ bottom: bottom + 56, maxHeight: 360, width: Math.min(width * 0.78, 320) }}
          >
            <ScrollView showsVerticalScrollIndicator={false}>
              <VStack>
                <Pressable
                  onPress={jumpTop}
                  accessibilityRole="button"
                  className="flex-row items-center px-4 py-3"
                >
                  <MaterialIcons name="vertical-align-top" size={18} color={ACCENT} style={{ marginRight: 10 }} />
                  <Text size="sm" className="text-white font-semibold">
                    {t('feed.sectionMenuTop')}
                  </Text>
                </Pressable>
                {sections.map((s) => (
                  <Pressable
                    key={s.id}
                    onPress={() => jump(s.id)}
                    accessibilityRole="button"
                    className="flex-row items-center px-4 py-3"
                  >
                    <Box className="flex-1 min-w-0 mr-3">
                      <Text size="sm" numberOfLines={1} className="text-typography-200">
                        {s.label}
                      </Text>
                    </Box>
                    <Text size="xs" className="text-typography-500">
                      {s.count}
                    </Text>
                  </Pressable>
                ))}
              </VStack>
            </ScrollView>
          </Box>
        </Pressable>
      </Modal>
    </>
  );
};

export default SectionJumpFab;
