import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../core/database/prisma.service';
import { AgentRunStatus, AgentRunType, TrainingStatus } from '@prisma/client';
import { AGENT_RUN_QUEUE } from '../agent/agent.service';

export const TRAINING_QUEUE = 'training';

export interface RiskProfile {
  maxDrawdown?: number;    // 0.0–1.0, e.g. 0.20 = 20% max drawdown
  aggressionLevel?: number; // 0.0 (very passive) to 1.0 (very aggressive)
}

export interface CreateSessionDto {
  name: string;
  description?: string;
  currency: string;
  dataFrom: Date;
  dataTo: Date;
  resolution?: string;
  algorithm?: string;
  allowedStrategies?: string[];  // legacy: strategy name strings
  allowedActions?: number[];     // new: action ID list (0–26)
  expiryDaysMin?: number;
  expiryDaysMax?: number;
  rollDteThreshold?: number;
  riskProfile?: RiskProfile;
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
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Training sessions
  // ---------------------------------------------------------------------------

  private buildHyperparams(dto: CreateSessionDto): Record<string, any> {
    const base = dto.hyperparams ?? {};
    const envOverrides: Record<string, any> = {};

    // Action whitelist: new action-ID list takes priority over legacy strategy names
    if (dto.allowedActions?.length) {
      envOverrides.allowed_actions = dto.allowedActions;
    } else if (dto.allowedStrategies?.length) {
      envOverrides.allowed_actions = dto.allowedStrategies.map((s) => s.toLowerCase());
    }

    // DTE range
    if (dto.expiryDaysMin !== undefined) envOverrides.expiry_days_min  = dto.expiryDaysMin;
    if (dto.expiryDaysMax !== undefined) envOverrides.expiry_days_max  = dto.expiryDaysMax;
    if (dto.rollDteThreshold !== undefined) envOverrides.roll_dte_threshold = dto.rollDteThreshold;

    if (dto.riskProfile) {
      const { maxDrawdown, aggressionLevel } = dto.riskProfile;
      if (maxDrawdown !== undefined) {
        envOverrides.max_drawdown_pct = maxDrawdown;
      }
      if (aggressionLevel !== undefined) {
        const a = Math.max(0, Math.min(1, aggressionLevel));
        envOverrides.position_size_pct = parseFloat((0.1 + a * 0.4).toFixed(3));
        envOverrides.ent_coef          = parseFloat((0.005 + a * 0.045).toFixed(4));
        envOverrides.loss_multiplier   = parseFloat((1.5 - a * 0.5).toFixed(3));
      }
    }

    return {
      ...base,
      env: { ...(base.env ?? {}), ...envOverrides },
    };
  }

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
        hyperparams: this.buildHyperparams(dto),
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

  /**
   * Hard-delete a session and all related data.
   * Cascade order:
   *   AgentRun.sessionId is nullable (SetNull default) → delete AgentRuns manually
   *   AgentAction.runId  has onDelete: Cascade       → auto-deleted with AgentRun
   *   TrainedModel.sessionId has onDelete: Cascade   → auto-deleted with TrainingSession
   */
  async deleteSession(id: string) {
    const session = await this.getSession(id); // 404 if not found

    // Pull queued/running job out of BullMQ before deleting the DB record
    if (session.jobId) {
      const job = await this.trainingQueue.getJob(session.jobId);
      await job?.remove().catch(() => null); // best-effort
    }

    await this.prisma.$transaction([
      // AgentActions cascade from AgentRun automatically
      this.prisma.agentRun.deleteMany({ where: { sessionId: id } }),
      // TrainedModel cascades from TrainingSession automatically
      this.prisma.trainingSession.delete({ where: { id } }),
    ]);

    return { deleted: true, id };
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
      obs_version?: string;
      obs_dims?: number;
      obs_features?: string[];
      action_dims?: number;
      data_columns?: string[];
      env_version?: string;
      policy?: string;
    },
    error?: string,
    userId?: string,
  ) {
    if (error) {
      return this.markFailed(id, error);
    }

    const session = await this.getSession(id);
    await this.markCompleted(id, result?.total_timesteps, result?.final_reward);

    if (result?.model_path) {
      await this.registerModel({
        sessionId:   id,
        name:        session.name,
        storagePath: result.model_path,
        sizeBytes:   result.size_bytes,
        meanReward:  result.mean_reward,
        stdReward:   result.std_reward,
        sharpeRatio: result.sharpe_ratio,
        maxDrawdown: result.max_drawdown,
        winRate:     result.win_rate,
        metadata: result.obs_version ? {
          obs_version:  result.obs_version,
          obs_dims:     result.obs_dims,
          obs_features: result.obs_features,
          action_dims:  result.action_dims,
          data_columns: result.data_columns,
          env_version:  result.env_version,
          policy:       result.policy,
        } : undefined,
      });

      if (userId) {
        try {
          const backtestRun = await this.prisma.agentRun.create({
            data: {
              userId,
              sessionId:         id,
              name:              `${session.name} — auto backtest`,
              currency:          session.currency,
              runType:           AgentRunType.BACKTEST,
              initialCapitalBtc: 1,
              currentCapitalBtc: 1,
              status:            AgentRunStatus.ACTIVE,
              totalActions:      0,
              realizedPnlBtc:    0,
            },
          });

          await this.agentRunQueue.add('execute', { runId: backtestRun.id }, {
            attempts: 2,
            backoff: { type: 'fixed', delay: 5_000 },
            removeOnComplete: false,
            removeOnFail:     false,
          });

          this.logger.log(`Auto-deployed backtest run ${backtestRun.id} for session ${id}`);
        } catch (err) {
          this.logger.error(`Auto-deploy failed for session ${id}: ${(err as Error).message}`);
        }
      }
    }

    return { ok: true };
  }

  async updateSession(id: string, data: { name?: string; description?: string }) {
    const session = await this.prisma.trainingSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Training session not found');
    return this.prisma.trainingSession.update({ where: { id }, data });
  }

  async updateModel(id: string, data: { name?: string }) {
    const model = await this.prisma.trainedModel.findUnique({ where: { id } });
    if (!model) throw new NotFoundException('Trained model not found');
    return this.prisma.trainedModel.update({ where: { id }, data });
  }

  async listModels() {
    return this.prisma.trainedModel.findMany({
      include: { session: { select: { name: true, algorithm: true, currency: true, totalTimesteps: true } } },
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
