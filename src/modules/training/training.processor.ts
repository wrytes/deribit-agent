import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { TrainingService, TRAINING_QUEUE } from './training.service';

interface TrainJobData {
  sessionId: string;
}

/**
 * BullMQ worker that processes training jobs.
 *
 * In this initial implementation it calls a Python FastAPI training sidecar
 * at TRAINER_URL (default http://localhost:8000). The sidecar is responsible
 * for reading the session config, pulling data from Postgres, training the
 * model, saving the artifact, and returning metrics.
 *
 * If TRAINER_URL is not configured the processor stubs completion so the
 * rest of the flow (DB state, model registration) can be tested without Python.
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
    this.logger.log(`Processing training job ${job.id} for session ${sessionId}`);

    await this.trainingService.markRunning(sessionId);

    const trainerUrl = this.configService.get<string>('TRAINER_URL') || 'http://localhost:8000';

    try {
      const response = await fetch(`${trainerUrl}/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(3600_000), // 1 hour max
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer responded ${response.status}: ${text}`);
      }

      const result = await response.json() as {
        total_timesteps?: number;
        final_reward?: number;
        model_path?: string;
        model_name?: string;
        size_bytes?: number;
        mean_reward?: number;
        std_reward?: number;
        sharpe_ratio?: number;
        max_drawdown?: number;
        win_rate?: number;
      };

      await this.trainingService.markCompleted(
        sessionId,
        result.total_timesteps,
        result.final_reward,
      );

      if (result.model_path) {
        await this.trainingService.registerModel({
          sessionId,
          name:        result.model_name ?? `model-${sessionId.slice(0, 8)}`,
          storagePath: result.model_path,
          sizeBytes:   result.size_bytes,
          meanReward:  result.mean_reward,
          stdReward:   result.std_reward,
          sharpeRatio: result.sharpe_ratio,
          maxDrawdown: result.max_drawdown,
          winRate:     result.win_rate,
        });
      }

      this.logger.log(`Training job ${job.id} completed — session ${sessionId}`);
    } catch (err) {
      this.logger.error(`Training job ${job.id} failed: ${err.message}`);
      await this.trainingService.markFailed(sessionId, err.message);
      throw err; // re-throw so BullMQ records the failure
    }
  }
}
