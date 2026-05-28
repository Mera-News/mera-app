import React from 'react';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useOnDeviceBannerStore } from '@/lib/stores/on-device-banner-store';

/**
 * "Processing news on your device" warning banner. Shown only while on-device
 * scoring is running in the foreground. Copy is intentionally firm — iOS can't
 * keep WebLLM awake if the app goes to background, and heavy scoring warms the
 * device.
 */
export default function OnDeviceProcessingBanner() {
  const visible = useOnDeviceBannerStore((s) => s.visible);
  if (!visible) return null;

  return (
    <Box className="mx-4 mt-2 rounded-xl border border-warning-600 bg-warning-900/30 p-4">
      <VStack space="sm">
        <HStack space="sm" className="items-center">
          <Heading size="sm" className="text-warning-100">
            Processing news on your device
          </Heading>
          <Box className="rounded-full border border-warning-600 px-2 py-0.5">
            <Text size="xs" className="text-warning-100">
              Beta
            </Text>
          </Box>
        </HStack>

        <Text size="sm" className="text-warning-100">
          Please keep the app open — scoring will pause if you close or
          background it.
        </Text>
        <Text size="sm" className="text-warning-100">
          Your device may get warm if there are many articles to process. This
          is normal.
        </Text>
      </VStack>
    </Box>
  );
}
