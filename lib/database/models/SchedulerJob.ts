import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export default class SchedulerJob extends Model {
  static table = 'scheduler_jobs';

  @field('task_name') taskName!: string;
  @field('status') status!: string;
  @field('input_json') inputJson!: string | null;
  @field('error_code') errorCode!: string | null;
  @field('error_message') errorMessage!: string | null;
  @field('attempt') attempt!: number;
  @field('max_attempts') maxAttempts!: number;
  @field('scheduled_at') scheduledAt!: number;
  @field('started_at') startedAt!: number | null;
  @field('completed_at') completedAt!: number | null;
  @field('retry_at') retryAt!: number | null;
}
