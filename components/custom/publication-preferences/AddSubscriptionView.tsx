import { flagForAlpha2, alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import SourceService from '@/lib/source-service';
import type { PublisherSearchHit } from '@/lib/generated/graphql-types';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChosenPublisher } from './use-subscriptions';

/**
 * Server-side `searchPublishers` rejects a query shorter than 2 characters
 * with a BadRequestException. Mirrored here so typing the first letter does
 * not fire a failing request on every keystroke.
 */
const MIN_QUERY_LENGTH = 2;

interface Props {
  readonly onChoose: (publisher: ChosenPublisher) => void;
  readonly disabled?: boolean;
}

/**
 * Inline publisher picker for the "Your subscriptions" section.
 *
 * Embedded panel with no route of its own, following
 * `components/custom/locations/AddLocationView.tsx` — that file's header
 * explains the pattern. The list of existing subscriptions stays mounted
 * below, so opening the picker does not replace the screen.
 *
 * All four states are named and rendered, because a search box that shows
 * nothing is indistinguishable from a broken one:
 *   1. query shorter than the minimum
 *   2. request in flight
 *   3. zero results, with a next step rather than a dead end
 *   4. the request failed
 */
const AddSubscriptionView: React.FC<Props> = ({ onChoose, disabled }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 300);
  const [results, setResults] = useState<PublisherSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearched(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    setFailed(false);
    SourceService.searchPublishers({ query: trimmed, first: 20 })
      .then((res) => {
        if (cancelled) return;
        setResults(res.publishers ?? []);
        setSearched(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setFailed(true);
        setResults([]);
        logger.captureException(error, {
          tags: { component: 'AddSubscriptionView', method: 'searchPublishers' },
        });
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const trimmed = debouncedQuery.trim();
  const tooShort = trimmed.length < MIN_QUERY_LENGTH;
  const showNoResults = !failed && !searching && searched && results.length === 0;

  return (
    <VStack space="sm" className="px-4 pb-2">
      <Input isDisabled={disabled}>
        <InputField
          value={query}
          onChangeText={setQuery}
          placeholder={t('subscriptions.searchPlaceholder')}
          accessibilityLabel={t('subscriptions.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Input>

      {tooShort && (
        <Text size="sm" className="text-gray-400">
          {t('subscriptions.searchTooShort')}
        </Text>
      )}

      {!tooShort && searching && (
        <HStack space="sm" className="items-center">
          <Spinner size="small" />
          <Text size="sm" className="text-gray-400">
            {t('subscriptions.searchInFlight')}
          </Text>
        </HStack>
      )}

      {failed && !searching && (
        <Text size="sm" className="text-gray-400">
          {t('subscriptions.searchError')}
        </Text>
      )}

      {showNoResults && (
        <Text size="sm" className="text-gray-400">
          {t('subscriptions.searchNoResults')}
        </Text>
      )}

      {!tooShort && !searching && results.length > 0 && (
        <VStack space="xs">
          {results.map((hit) => (
            <Pressable
              key={hit._id}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={hit.name}
              onPress={() =>
                onChoose({
                  publisherId: hit._id,
                  publisherName: hit.name,
                  countryCode: hit.country_code,
                  // Explicit null, never undefined: a publisher confirmed to
                  // have no consumer subscription product must read the same
                  // as one whose field was never set, and the no-URI branch
                  // keys off exactly this.
                  subscriptionUri: hit.subscription_uri ?? null,
                })
              }
            >
              <Box className="py-3">
                <HStack space="sm" className="items-center">
                  <Text size="md">{flagForAlpha2(alpha3ToAlpha2(hit.country_code))}</Text>
                  <Text size="md" className="text-typography-0 flex-1">
                    {hit.name}
                  </Text>
                </HStack>
              </Box>
            </Pressable>
          ))}
        </VStack>
      )}
    </VStack>
  );
};

export default AddSubscriptionView;
