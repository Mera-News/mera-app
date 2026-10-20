// The encryption strip at rest, drawn with react-native-svg: motion off, or no
// Lottie file on disk. Geometry is the design board's WaitBubble resting frame.
// Colours are the same opaque flattened ink2 / ink3 the Lottie colorFilters use.

import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import Svg, { Circle, Line, Rect } from 'react-native-svg';
import { STRIP_HEIGHT } from './chat-phases';
import { stripColorFilters } from './strip-display';

export interface StaticStripProps {
  /** The phone alone (on-device), not the line to the model. */
  device: boolean;
}

export const StaticStrip: React.FC<StaticStripProps> = ({ device }) => {
  const [ink, ink3] = stripColorFilters(useColors(), 'row');
  return (
    <Svg
      width="100%"
      height={STRIP_HEIGHT}
      viewBox={device ? '0 0 28 32' : '0 0 272 32'}
      accessible={false}
    >
      {!device && (
        <>
          <Line x1={28} y1={16} x2={236} y2={16} stroke={ink3.color} strokeWidth={1.2} opacity={0.35} />
          <Circle cx={133} cy={16} r={3.5} fill="none" stroke={ink3.color} strokeWidth={1.2} opacity={0.35} />
        </>
      )}
      <Rect x={4} y={1} width={20} height={30} rx={4} fill="none" stroke={ink.color} strokeWidth={1.6} strokeLinejoin="round" />
      <Line x1={11.5} y1={28.2} x2={16.5} y2={28.2} stroke={ink3.color} strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
};

export default StaticStrip;
