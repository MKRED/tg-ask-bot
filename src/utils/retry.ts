import logger from "../logger";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 1500,
  label = "operation"
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        logger.warn({ err, attempt: i, label }, `Attempt ${i} failed, retrying in ${delayMs * i}ms`);
        await sleep(delayMs * i);
      }
    }
  }
  throw lastErr;
}
