import { Model } from '@nozbe/watermelondb';
import { field, json, date, writer } from '@nozbe/watermelondb/decorators';

export type InferenceJobType = 'topic_gen';
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
