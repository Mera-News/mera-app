// data-meter-model: the Your data card's figures. Pure; no log of any size.

import { gbText } from '@/lib/algorithms/format-bytes';
import type { LocalDataSizes } from '@/lib/database/local-data-size';

export interface MeterRow {
  readonly key: 'database' | 'model' | 'backup';
  readonly value: string;
}

export interface MeterFigures {
  readonly used: string;
  /** Null when the free space is unknown. */
  readonly free: string | null;
  readonly rows: readonly MeterRow[];
  /** Used over used plus free; null when free is unknown. */
  readonly fraction: number | null;
}

/**
 * MB under 1 GB of the summed total, else GB to one decimal. Each row is
 * rounded in that unit and the shown total is the sum of the rounded rows, so
 * the card always adds up. Whole units (MB, tenths of a GB) keep the sum exact.
 */
export function meterFigures(sizes: LocalDataSizes, locale: string): MeterFigures {
  const parts: { key: MeterRow['key']; bytes: number }[] = [{ key: 'database', bytes: sizes.databaseBytes }];
  if (sizes.modelBytes !== null) parts.push({ key: 'model', bytes: sizes.modelBytes });
  if (sizes.backupBytes > 0) parts.push({ key: 'backup', bytes: sizes.backupBytes });

  const gb = parts.reduce((sum, p) => sum + p.bytes, 0) >= 1e9;
  const step = gb ? 1e8 : 1e6;
  const units = (bytes: number) => Math.round(bytes / step);
  const text = (n: number) => (gb ? `${gbText(n * step, locale)} GB` : `${n.toLocaleString(locale)} MB`);

  const rounded = parts.map((p) => ({ key: p.key, n: units(p.bytes) }));
  const usedBytes = parts.reduce((sum, p) => sum + p.bytes, 0);
  return {
    used: text(rounded.reduce((sum, r) => sum + r.n, 0)),
    free: sizes.freeBytes === null ? null : text(units(sizes.freeBytes)),
    rows: rounded.map((r) => ({ key: r.key, value: text(r.n) })),
    fraction: sizes.freeBytes === null ? null : usedBytes / (usedBytes + sizes.freeBytes),
  };
}
