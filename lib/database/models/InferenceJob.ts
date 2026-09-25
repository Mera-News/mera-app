import { Model } from '@nozbe/watermelondb';
import { field, json, date, writer } from '@nozbe/watermelondb/decorators';

export type InferenceJobType =
  | 'topic_gen'
  | 'persona_summary'
  | 'story_headline'
  | 'tracked_story_migrate'
  // One fact of the deferred combination pass. Payload `{ factId, passId }`
  // only: the fact and its siblings are read at run time, never carried.
  | 'topic_combo';
export type InferenceJobStatus = 'pending' | 'running' | 'done' | 'failed';

const sanitizeJson = (raw: unknown) => raw || {};

export default class InferenceJob extends Model {
  static table = 'inference_jobs';

  @field('job_type') jobType!: InferenceJobType;
  @field('status') status!: InferenceJobStatus;
  @field('priority') priority!: number;
  @json('payload_json', sanitizeJson) payload!: Record<string, unknown>;
  @json('result_json', sanitizeJson) result?: Record<string, unknown>;
  @field('error_message') errorMessage?: string | null;
  @field('attempts') attempts!: number;
  @field('max_attempts') maxAttempts!: number;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  @writer async markRunning() {
    await this.update((job) => {
      job.status = 'running';
      job.attempts = (job.attempts || 0) + 1;
    });
  }

  @writer async markDone(result: Record<string, unknown>) {
    await this.update((job) => {
      job.status = 'done';
      job.result = result;
    });
  }

  /**
   * A job this bundle cannot run at all (no handler for its type). COUNTS an
   * attempt, which `markFailed` alone does not: the job never reached
   * `markRunning`, so without the increment `attempts` never moves, the job is
   * re-pended on every loop and the queue spins forever. That is exactly what
   * an OTA rollback does to a job type the older bundle has never heard of.
   */
  @writer async markUnrunnable(errorMessage: string) {
    const attempts = (this.attempts || 0) + 1;
    if (attempts >= this.maxAttempts) {
      await this.destroyPermanently();
      return;
    }
    await this.update((job) => {
      job.attempts = attempts;
      job.status = 'pending';
      job.errorMessage = errorMessage;
    });
  }

  /**
   * "Not now" rather than "failed": offline, no local credential, a gateway
   * 503 or a 429. Re-pends and GIVES BACK the attempt `markRunning` took, so an
   * app closed offline cannot burn a job's three attempts on conditions that
   * say nothing about the job. The delay is not stored here (no column, and a
   * schema bump is not worth it): the queue gates the whole job TYPE in memory.
   */
  @writer async markDeferred(reason: string) {
    await this.update((job) => {
      job.status = 'pending';
      job.attempts = Math.max(0, (job.attempts || 0) - 1);
      job.errorMessage = reason;
    });
  }

  @writer async markFailed(errorMessage: string) {
    if (this.attempts >= this.maxAttempts) {
      await this.destroyPermanently();
      return;
    }
    await this.update((job) => {
      job.status = 'pending';
      job.errorMessage = errorMessage;
    });
  }
}
