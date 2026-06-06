import logger from '@/lib/logger';

export async function withRetry<T>(
  op: () => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3,
  tag = '[retry]',
): Promise<T> {
  let delay = 100;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      return await op();
    } catch (err) {
      if (signal?.aborted) throw new Error('aborted');
      if (attempt === maxRetries) throw err;
      logger.warn(`${tag} retry ${attempt + 1}/${maxRetries}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error(`${tag} withRetry: unexpected exit`);
}
