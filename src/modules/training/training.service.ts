import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../core/database/prisma.service';
import { TrainingStatus } from '@prisma/client';

export const TRAINING_QUEUE = 'training';

export interface CreateSessionDto {
  name: string;
  description?: string;
  currency: string;
  dataFrom: Date;
  dataTo: Date;
  resolution?: string;
  algorithm?: string;
  hyperparams?: Record<string, any>;
}

export interface CreateModelDto {
  sessionId: string;
  name: string;
  storagePath: string;
  storageType?: string;
  sizeBytes?: number;
  meanReward?: number;
  stdReward?: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  winRate?: number;
  metadata?: Record<string, any>;
}

@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TRAINING_QUEUE) private readonly trainingQueue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Training sessions
  // ---------------------------------------------------------------------------

  async createSession(dto: CreateSessionDto) {
    const session = await this.prisma.trainingSession.create({
      data: {
        name:        dto.name,
        description: dto.description,
        currency:    dto.currency,
        dataFrom:    dto.dataFrom,
        dataTo:      dto.dataTo,
        resolution:  dto.resolution  ?? '1D',
        algorithm:   dto.algorithm   ?? 'PPO',
        hyperparams: dto.hyperparams ?? {},
        status:      TrainingStatus.QUEUED,
      },
    });

    const job = await this.trainingQueue.add('train', { sessionId: session.id }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 }, // 15s, 30s, 60s, 120s, 240s
      removeOnComplete: false,
      removeOnFail:     false,
    });

    await this.prisma.trainingSession.update({
      where: { id: session.id },
      data:  { jobId: String(job.id) },
    });

    this.logger.log(`Training session ${session.id} queued as job ${job.id}`);
    return session;
  }

  async listSessions(status?: TrainingStatus) {
    return this.prisma.trainingSession.findMany({
      where: status ? { status } : {},
      include: { model: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSession(id: string) {
    const session = await this.prisma.trainingSession.findUnique({
      where: { id },
      include: { model: true },
    });
    if (!session) throw new NotFoundException('Training session not found');
    return session;
  }

  async cancelSession(id: string) {
    const session = await this.getSession(id);

    const cancellable: string[] = [TrainingStatus.QUEUED, TrainingStatus.RUNNING];
    if (!cancellable.includes(session.status)) {
      throw new BadRequestException(`Cannot cancel a session with status ${session.status}`);
    }

    if (session.jobId) {
      const job = await this.trainingQueue.getJob(session.jobId);
      await job?.remove();
    }

    return this.prisma.trainingSession.update({
      where: { id },
      data:  { status: TrainingStatus.CANCELLED },
    });
  }

  /** Called by the processor to mark a session as started. */
  async markRunning(id: string) {
    return this.prisma.trainingSession.update({
      where: { id },
      data:  { status: TrainingStatus.RUNNING, startedAt: new Date() },
    });
  }

  /** Called by the processor when training completes successfully. */
  async markCompleted(id: string, totalTimesteps?: number, finalReward?: number) {
    return this.prisma.trainingSession.update({
      where: { id },
      data: {
        status:        TrainingStatus.COMPLETED,
        completedAt:   new Date(),
        totalTimesteps,
        finalReward,
      },
    });
  }

  /** Called by the processor when training fails. */
  async markFailed(id: string, errorMessage: string) {
    return this.prisma.trainingSession.update({
      where: { id },
      data: {
        status:        TrainingStatus.FAILED,
        completedAt:   new Date(),
        errorMessage,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Queue inspection
  // ---------------------------------------------------------------------------

  async getQueueStats() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.trainingQueue.getWaitingCount(),
      this.trainingQueue.getActiveCount(),
      this.trainingQueue.getCompletedCount(),
      this.trainingQueue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }

  // ---------------------------------------------------------------------------
  // Trained models
  // ---------------------------------------------------------------------------

  async registerModel(dto: CreateModelDto) {
    return this.prisma.trainedModel.create({
      data: {
        sessionId:   dto.sessionId,
        name:        dto.name,
        storagePath: dto.storagePath,
        storageType: dto.storageType ?? 'local',
        sizeBytes:   dto.sizeBytes,
        meanReward:  dto.meanReward,
        stdReward:   dto.stdReward,
        sharpeRatio: dto.sharpeRatio,
        maxDrawdown: dto.maxDrawdown,
        winRate:     dto.winRate,
        metadata:    dto.metadata ?? {},
      },
    });
  }

  /** Called by the trainer sidecar via POST /training/sessions/:id/callback. */
  async handleTrainerCallback(
    id: string,
    result?: {
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
    },
    error?: string,
  ) {
    if (error) {
      return this.markFailed(id, error);
    }

    await this.markCompleted(id, result?.total_timesteps, result?.final_reward);

    if (result?.model_path) {
      await this.registerModel({
        sessionId:   id,
        name:        result.model_name ?? `model-${id.slice(0, 8)}`,
        storagePath: result.model_path,
        sizeBytes:   result.size_bytes,
        meanReward:  result.mean_reward,
        stdReward:   result.std_reward,
        sharpeRatio: result.sharpe_ratio,
        maxDrawdown: result.max_drawdown,
        winRate:     result.win_rate,
      });
    }

    return { ok: true };
  }

  async listModels() {
    return this.prisma.trainedModel.findMany({
      include: { session: { select: { name: true, algorithm: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getModel(id: string) {
    const model = await this.prisma.trainedModel.findUnique({
      where: { id },
      include: { session: true },
    });
    if (!model) throw new NotFoundException('Trained model not found');
    return model;
  }
}
