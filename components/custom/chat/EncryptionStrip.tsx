// The encryption strip: the phone, the line and the model, drawn from the phase
// store. The reducer in `strip-display.ts` decides what is shown; this file
// plays it (Lottie, or the static svg at rest) and lays the real Mera mark over
// the model end (cloud) or the phone's screen (device).
//
// Motion gate is `useMotionAllowed()`, never `useAnimationsActive()`: a
// liveness drawing must not freeze on a backgrounded chat.

import { LayeredMark } from '@/components/custom/MeraLogo';
import logger from '@/lib/logger';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useMotionAllowed } from '@/lib/motion-gate';
import { stripStateFor } from '@/lib/services/chat-phase';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import LottieView from 'lottie-react-native';
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { CHAT_DEVICE_SCREEN_BOX, CHAT_STRIP_MARK_BOX, chatStripAnimationFor } from './animation-registry';
import { STRIP_HEIGHT } from './chat-phases';
import StaticStrip from './StaticStrip';
import {
  initStripDisplay,
  markFor,
  markLayout,
  reduceStripDisplay,
  stripColorFilters,
  stripPlayback,
  type StripDisplay,
  type StripHost,
} from './strip-display';

export interface EncryptionStripProps {
  host: StripHost;
  /** Hold the resting frame while something else moves. */
  rest?: boolean;
  /** Bump to request one `return` play. */
  playReturn?: number;
  onReturnDone?: () => void;
  /** Handover overlay: plays `return` once and ignores the store. */
  fixed?: 'return';
}

const HIDDEN = {
  accessible: false,
  importantForAccessibility: 'no-hide-descendants',
  accessibilityElementsHidden: true,
} as const;

export const EncryptionStrip: React.FC<EncryptionStripProps> = ({
  host,
  rest = false,
  playReturn,
  onReturnDone,
  fixed,
}) => {
  const colors = useColors();
  const scheme = useThemeMode();
  const motion = useMotionAllowed();
  const engine = useIsOnDeviceProcessing() ? 'local' : 'cloud';
  const view = useChatPhaseStore((s) => s.view);
  const deviceWork = useChatPhaseStore((s) => s.deviceWork);
  const sealedSeq = useChatPhaseStore((s) => s.sealedSeq);
  const target = stripStateFor(view, deviceWork, engine);

  const [display, dispatch] = useReducer(
    (s: StripDisplay, e: Parameters<typeof reduceStripDisplay>[1]) => reduceStripDisplay(s, e),
    undefined,
    (): StripDisplay =>
      fixed
        ? { shown: 'return', playing: motion, owed: null, seq: sealedSeq }
        : initStripDisplay(target, sealedSeq),
  );
  const shownRef = useRef(display.shown);
  shownRef.current = display.shown;
  const doneRef = useRef(onReturnDone);
  doneRef.current = onReturnDone;

  useEffect(() => {
    if (!fixed) dispatch({ type: 'target', state: target, sealedSeq, motion });
  }, [fixed, target, sealedSeq, motion]);

  const firstReturn = useRef(playReturn);
  useEffect(() => {
    if (fixed || playReturn === firstReturn.current) return;
    firstReturn.current = playReturn;
    if (!motion) {
      doneRef.current?.();
      return;
    }
    dispatch({ type: 'return', motion });
  }, [fixed, playReturn, motion]);

  const finish = () => {
    const wasReturn = shownRef.current === 'return';
    dispatch({ type: 'finished' });
    if (wasReturn) doneRef.current?.();
  };

  const playback = stripPlayback(display.shown, { motion, rest, playing: display.playing });
  useEffect(() => {
    if (playback.kind === 'svg' && display.playing) finish();
    // fixed with motion off never plays: report done once.
    else if (fixed && !display.playing && playback.kind === 'svg') doneRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.kind, display.playing]);

  const mark = markFor(display.shown, rest);
  const box = mark.place === 'phone' ? CHAT_DEVICE_SCREEN_BOX : CHAT_STRIP_MARK_BOX;
  const [width, setWidth] = useState<number>(box.stripW);
  const place = markLayout(box, width);
  const device = playback.device;
  const stripW = device ? CHAT_DEVICE_SCREEN_BOX.stripW : CHAT_STRIP_MARK_BOX.stripW;

  // Dev only: which drawing the strip chose, once per change, so a capture can
  // tell the Lottie from the resting svg without reading pixels.
  const choice = `${playback.kind}:${playback.kind === 'lottie' ? playback.id : device ? 'device' : 'cloud'}:${display.shown}:${motion ? 'motion' : 'still'}`;
  useEffect(() => {
    if (__DEV__) logger.info('[EncryptionStrip] draw', { host, choice });
  }, [host, choice]);

  return (
    <View
      {...HIDDEN}
      style={[styles.box, { maxWidth: stripW, width: device ? stripW : '100%' }]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      {playback.kind === 'svg' ? (
        <StaticStrip device={device} />
      ) : (
        <LottieView
          key={`${playback.id}-${scheme}-${display.shown}`}
          source={chatStripAnimationFor(playback.id) as never}
          style={styles.fill}
          loop={playback.loop}
          autoPlay={playback.autoPlay}
          progress={playback.progress}
          colorFilters={stripColorFilters(colors, host)}
          onAnimationFinish={(cancelled: boolean) => {
            if (!cancelled) finish();
          }}
        />
      )}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: place.left,
          top: place.top,
          width: place.size,
          height: place.size,
          opacity: mark.opacity,
        }}
      >
        <LayeredMark size={place.size} color={colors.ink} cone cards={false} still={!mark.animated} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  box: { height: STRIP_HEIGHT, direction: 'ltr' },
  fill: { width: '100%', height: STRIP_HEIGHT },
});

export default EncryptionStrip;
