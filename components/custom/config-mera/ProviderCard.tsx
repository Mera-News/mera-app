// Private cloud tab: which providers the lanes use right now and which model each lane runs.
// Reads the router's live state, so a failover shows here as it happens. Layered (owner): closed it is
// one bare Provider row with no data, so a reader who won't follow it sees nothing technical; a tap
// shows the links and the model per lane.
import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';
import { Group, GroupLabel, Row } from '@/components/custom/you/rows';
import { Text } from '@/components/ui/text';
import { DEFAULT_TABLE, PROFILES } from '@/lib/llm/profiles';
import { useRoutingState, type Lane } from '@/lib/llm/router';
import { useColors } from '@/lib/theme/tokens';

const LANE_ROWS = [
  ['chat-tools', 'meraProtocol.providers.laneChat'],
  ['scoring', 'meraProtocol.providers.laneScoring'],
  ['topics', 'meraProtocol.providers.laneTopics'],
  ['background', 'meraProtocol.providers.laneBackground'],
] as const satisfies readonly (readonly [Lane, string])[];

export function ProviderCard() {
  const { t } = useTranslation();
  const colors = useColors();
  const { lanes } = useRoutingState();

  // A lane with no profile and no outage is not routed (on-device mode): no row for it.
  const shown = LANE_ROWS.filter(([lane]) => lanes[lane].state === 'down' || lanes[lane].active);
  const providers = new Map<string, { name: string; url: string }>();
  for (const [lane] of shown) {
    const { state, active } = lanes[lane];
    if (state !== 'down' && active)
      providers.set(active.provider, { name: active.providerName, url: active.providerUrl });
  }
  // Backup = a provider that no lane's first default choice names.
  const primary = new Set(Object.values(DEFAULT_TABLE).map((ids) => PROFILES[ids[0]].provider));

  const [open, setOpen] = useState(false);
  if (shown.length === 0) return null;
  return (
    <View testID="mera-protocol-provider-card">
      <Group>
        <Row
          testID="provider-card-toggle"
          title={t('meraProtocol.providers.title')}
          onPress={() => setOpen((o) => !o)}
          hideChevron
          expanded={open}
          trailing={
            <MaterialIcons
              name={open ? 'expand-less' : 'expand-more'}
              size={22}
              color={colors.ink2}
            />
          }
        />
      </Group>
      {!open ? null : providers.size > 0 ? (
        <>
          <GroupLabel>{t('meraProtocol.providers.title')}</GroupLabel>
          <Group>
            {[...providers].map(([provider, { name, url }]) => (
              <Pressable
                key={provider}
                testID={`provider-link-${provider}`}
                onPress={() => void Linking.openURL(url)}
                accessibilityRole="link"
                accessibilityLabel={t('meraProtocol.providers.openA11y', { provider: name })}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 48,
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                }}
              >
                <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 21, flexShrink: 1 }}>
                  {name}
                </Text>
                <MaterialIcons name="north-east" size={16} color={colors.ink2} />
                {primary.has(provider as never) ? null : (
                  <Text style={{ color: colors.ink2, fontSize: 13 }}>
                    ({t('meraProtocol.providers.backup')})
                  </Text>
                )}
              </Pressable>
            ))}
          </Group>
        </>
      ) : null}
      {open ? (
        <>
          <GroupLabel>{t('meraProtocol.providers.modelsTitle')}</GroupLabel>
          <Group>
            {shown.map(([lane, key]) => (
              <Row
                key={lane}
                testID={`provider-lane-${lane}`}
                title={t(key)}
                value={
                  lanes[lane].state === 'down' || !lanes[lane].active
                    ? t('meraProtocol.providers.paused')
                    : lanes[lane].active!.modelLabel
                }
              />
            ))}
          </Group>
        </>
      ) : null}
    </View>
  );
}
