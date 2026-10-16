// Which line sits under the "On this phone" row. The cantRun reason wins:
// a row that cannot be picked never also advertises its limits.
export type OnDeviceSubtitle = 'cantRun' | 'needsCloud';

export function onDeviceSubtitleKind(cantRun: boolean): OnDeviceSubtitle {
  return cantRun ? 'cantRun' : 'needsCloud';
}
