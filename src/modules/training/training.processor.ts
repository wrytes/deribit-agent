import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { TrainingService, TRAINING_QUEUE } from './training.service';

interface TrainJobData {
  sessionId: string;
}

/**
 * BullMQ worker — hands the session off to the Python trainer sidecar and
 * resolves immediately. The trainer runs asynchronously and calls back to
 * POST /training/sessions/:id/callback when done (or on failure).
 */
@Processor(TRAINING_QUEUE)
export class TrainingProcessor extends WorkerHost {
  private readonly logger = new Logger(TrainingProcessor.name);

  constructor(
    private readonly trainingService: TrainingService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<TrainJobData>): Promise<void> {
    const { sessionId } = job.data;
    this.logger.log(`Handing off training job ${job.id} to trainer — session ${sessionId}`);

    await this.trainingService.markRunning(sessionId);

    const trainerUrl = this.configService.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    try {
      const response = await fetch(`${trainerUrl}/train`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_id: sessionId }),
        signal:  AbortSignal.timeout(30_000), // 30s just to confirm the trainer accepted
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer rejected job ${response.status}: ${text}`);
      }

      this.logger.log(`Training job ${job.id} accepted by trainer — waiting for callback`);
    } catch (err) {
      this.logger.error(`Training job ${job.id} failed to start: ${err.message}`);
      await this.trainingService.markFailed(sessionId, err.message);
      throw err;
    }
  }
}
