/**
 * Shared Redis connection for BullMQ. One IORedis instance, reused by every
 * Queue and Worker in the process — BullMQ recommends this over letting
 * each queue open its own connection.
 */
import IORedis from "ioredis";

let connection: IORedis | undefined;

export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "REDIS_URL is not set. Copy .env.example to .env and fill it in.",
      );
    }
    // BullMQ requires this — it manages retry/backoff itself and will
    // throw if ioredis's own retry strategy is left enabled underneath it.
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = undefined;
  }
}
