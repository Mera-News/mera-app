// format-bytes: storage sizes in decimal units, the way phones report them.

/** The GB figure alone, one decimal: 1234000000 -> "1.2". */
export const gbText = (bytes: number): string => (bytes / 1e9).toFixed(1);

/** A size with its unit: "412 MB", "38.2 GB". */
export function sizeText(bytes: number): string {
  return bytes < 1e9 ? `${Math.round(bytes / 1e6)} MB` : `${gbText(bytes)} GB`;
}
