import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrainingService, TRAINING_QUEUE } from './training.service';

interface TrainJobData {
  sessionId: string;
}

/**
 * BullMQ worker — marks the session RUNNING so the trainer polling loop picks it up.
 * The trainer writes results directly to the DB when done.
 */
@Processor(TRAINING_QUEUE)
export class TrainingProcessor extends WorkerHost {
  private readonly logger = new Logger(TrainingProcessor.name);

  constructor(private readonly trainingService: TrainingService) {
    super();
  }

  async process(job: Job<TrainJobData>): Promise<void> {
    const { sessionId } = job.data;
    this.logger.log(`Marking session ${sessionId} RUNNING (job ${job.id})`);
    await this.trainingService.markRunning(sessionId);
  }
}
