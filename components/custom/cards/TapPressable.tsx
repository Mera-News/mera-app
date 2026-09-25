// The app's Pressable, opening on a TAP only (`useTapGuard`): a release after
// a sideways drag is not a press. For rows and cards that are not
// `PressableCard` (which does the same and adds the held-state opacity), so
// their look is unchanged.

import { Pressable } from '@/components/ui/pressable';
import React from 'react';
import { useTapGuard } from './use-tap-guard';

type PressableProps = React.ComponentProps<typeof Pressable>;

const TapPressable = React.forwardRef<React.ComponentRef<typeof Pressable>, PressableProps>(function TapPressable(
    { onPress, onPressIn, ...rest },
    ref,
) {
    const tap = useTapGuard(onPress, onPressIn);
    return <Pressable ref={ref} {...rest} onPress={tap.onPress} onPressIn={tap.onPressIn} />;
});

export default TapPressable;
