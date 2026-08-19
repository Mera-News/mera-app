// Base64 for the backup file adapters.
//
// RNFS is a string API: `write(path, data, position, 'base64')` and
// `read(path, length, position, 'base64')`. Everything in `lib/backup` speaks
// `Uint8Array`, so this is the only place the two meet.
//
// The chunking is not premature. `String.fromCharCode(...bytes)` blows the
// argument limit on anything large, and appending one character at a time is
// O(n) string builds — the seal path hands these 256 KB at a time. 8192 is
// comfortably under every engine's spread limit while keeping the loop short.

const CHUNK = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length)) as unknown as number[],
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
