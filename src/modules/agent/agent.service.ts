import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../core/database/prisma.service';
import { AgentRunStatus, AgentRunType } from '@prisma/client';

export const AGENT_RUN_QUEUE = 'agent-run';

export class SaveSettingsDto {
  @IsOptional() @IsString()   dataFrom?: string;
  @IsOptional() @IsString()   dataTo?: string;
  @IsOptional() @IsArray() @IsInt({ each: true })   allowed_actions?: number[];
  @IsOptional() @IsNumber()   max_drawdown_limit?: number;
  @IsOptional() @IsNumber()   aggression_level?: number;
  @IsOptional() @IsNumber()   position_size_pct?: number;
  @IsOptional() @IsNumber()   max_position_btc?: number;
  @IsOptional() @IsNumber()   min_order_size?: number;
  @IsOptional() @IsInt()      expiry_days_min?: number;
  @IsOptional() @IsInt()      expiry_days_max?: number;
  @IsOptional() @IsInt()      roll_dte_threshold?: number;
  @IsOptional() @IsNumber()   max_margin_ratio?: number;
  @IsOptional() @IsNumber()   delta_threshold?: number;
  @IsOptional() @IsNumber()   delta_penalty_coef?: number;
  @IsOptional() @IsNumber()   risk_free_rate?: number;
  @IsOptional() @IsBoolean()  fast_margin?: boolean;
}

export interface CreateRunDto {
  userId: string;
  sessionId?: string;
  name: string;
  currency: string;
  runType?: AgentRunType;
  deribitAccountId?: string;
  initialCapitalBtc: number;
  notes?: string;
}

export interface LogActionDto {
  runId: string;
  actionType: string;
  timestamp?: Date;
  instrument?: string;
  quantity?: number;
  price?: number;
  orderId?: string;
  btcPrice?: number;
  delta?: number;
  ivRank?: number;
  executedPrice?: number;
  pnlBtc?: number;
  feeBtc?: number;
  thetaBtc?: number;
  cashflowBtc?: number;
  equityBtc?: number;
  marginBalanceBtc?: number;
  reason?: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RUN_QUEUE) private readonly agentRunQueue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Agent runs
  // ---------------------------------------------------------------------------

  async createRun(dto: CreateRunDto) {
    if (dto.runType === AgentRunType.LIVE && !dto.deribitAccountId) {
      throw new BadRequestException('deribitAccountId is required for LIVE agents');
    }

    const run = await this.prisma.agentRun.create({
      data: {
        userId:            dto.userId,
        sessionId:         dto.sessionId,
        name:              dto.name,
        currency:          dto.currency,
        runType:           dto.runType ?? AgentRunType.PAPER,
        deribitAccountId:  dto.deribitAccountId,
        initialCapitalBtc: dto.initialCapitalBtc,
        currentCapitalBtc: dto.initialCapitalBtc,
        notes:             dto.notes,
        status:            AgentRunStatus.ACTIVE,
      },
    });

    if (run.runType === AgentRunType.BACKTEST && run.sessionId) {
      await this.agentRunQueue.add('execute', { runId: run.id }, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: false,
        removeOnFail:     false,
      });
    }

    if (run.runType === AgentRunType.PAPER && run.sessionId) {
      await this.agentRunQueue.add('execute', { runId: run.id, jobType: 'paper-tick' }, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: false,
        removeOnFail:     false,
      });
    }

    return run;
  }

  async listRuns(userId: string, status?: AgentRunStatus) {
    return this.prisma.agentRun.findMany({
      where: {
        userId,
        ...(status ? { status } : {}),
      },
      include: {
        session: { select: { name: true, algorithm: true } },
        _count: { select: { actions: true } },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  async getRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
      include: {
        session: { select: { name: true, algorithm: true, currency: true, hyperparams: true } },
        actions: { orderBy: { timestamp: 'desc' }, take: 100 },
      },
    });
    if (!run) throw new NotFoundException('Agent not found');
    return run;
  }

  async saveSettings(userId: string, runId: string, dto: SaveSettingsDto) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    return this.prisma.agentRun.update({
      where: { id: runId },
      data: { executionSettings: dto as any },
    });
  }

  async updateRun(userId: string, id: string, data: { name?: string; notes?: string }) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    return this.prisma.agentRun.update({ where: { id }, data });
  }

  async deleteRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId: id } }),
      this.prisma.agentRun.delete({ where: { id } }),
    ]);
    return { deleted: true, id };
  }

  async stopRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.ACTIVE && run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException(`Cannot stop an agent with status ${run.status}`);
    }

    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
    });
  }

  async pauseRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException('Can only pause an ACTIVE agent');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.PAUSED },
    });
  }

  async resumeRun(userId: string, id: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id, userId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (run.status !== AgentRunStatus.PAUSED) {
      throw new BadRequestException('Can only resume a PAUSED agent');
    }
    return this.prisma.agentRun.update({
      where: { id },
      data:  { status: AgentRunStatus.ACTIVE },
    });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async logActionBatch(
    runId: string,
    actions: Omit<LogActionDto, 'runId'>[],
    opts?: { currentCapitalBtc?: number; paperState?: Record<string, unknown> },
  ) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Agent not found');
    if (!actions.length && !opts?.currentCapitalBtc && !opts?.paperState) return { logged: 0 };

    if (actions.length) {
      await this.prisma.agentAction.createMany({
        data: actions.map((a) => ({
          runId,
          actionType:      a.actionType,
          ...(a.timestamp ? { timestamp: a.timestamp } : {}),
          instrument:      a.instrument,
          quantity:        a.quantity,
          price:           a.price,
          orderId:         a.orderId,
          btcPrice:        a.btcPrice,
          delta:           a.delta,
          ivRank:          a.ivRank,
          executedPrice:   a.executedPrice,
          pnlBtc:           a.pnlBtc,
          feeBtc:           a.feeBtc,
          thetaBtc:         a.thetaBtc,
          cashflowBtc:      a.cashflowBtc,
          equityBtc:        a.equityBtc,
          marginBalanceBtc: a.marginBalanceBtc,
          reason:           a.reason,
        })),
      });
    }

    const totalPnl = actions.reduce((s, a) => s + (Number(a.pnlBtc) || 0), 0);
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        ...(actions.length ? { totalActions: { increment: actions.length } } : {}),
        ...(totalPnl       ? { realizedPnlBtc: { increment: totalPnl } }    : {}),
        ...(opts?.currentCapitalBtc !== undefined ? { currentCapitalBtc: opts.currentCapitalBtc } : {}),
        ...(opts?.paperState        !== undefined ? { paperState: opts.paperState as any }         : {}),
      },
    });

    return { logged: actions.length };
  }

  async logAction(dto: LogActionDto) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: dto.runId } });
    if (!run) throw new NotFoundException('Agent not found');

    const action = await this.prisma.agentAction.create({
      data: {
        runId:           dto.runId,
        actionType:      dto.actionType,
        ...(dto.timestamp ? { timestamp: dto.timestamp } : {}),
        instrument:      dto.instrument,
        quantity:        dto.quantity,
        price:           dto.price,
        orderId:         dto.orderId,
        btcPrice:        dto.btcPrice,
        delta:           dto.delta,
        ivRank:          dto.ivRank,
        executedPrice:   dto.executedPrice,
        pnlBtc:           dto.pnlBtc,
        feeBtc:           dto.feeBtc,
        thetaBtc:         dto.thetaBtc,
        cashflowBtc:      dto.cashflowBtc,
        equityBtc:        dto.equityBtc,
        marginBalanceBtc: dto.marginBalanceBtc,
        reason:           dto.reason,
      },
    });

    // Update run counters
    const updates: Record<string, any> = {
      totalActions: { increment: 1 },
    };
    if (dto.pnlBtc !== undefined) {
      updates.realizedPnlBtc = { increment: dto.pnlBtc };
    }

    await this.prisma.agentRun.update({
      where: { id: dto.runId },
      data:  updates,
    });

    return action;
  }

  async getRunActions(userId: string, runId: string, limit?: number) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new NotFoundException('Agent not found');

    return this.prisma.agentAction.findMany({
      where: { runId },
      orderBy: { timestamp: 'desc' },
      take: limit ?? 200,
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getRunSummary(userId: string, runId: string) {
    const run = await this.getRun(userId, runId);

    const actionBreakdown = await this.prisma.$queryRaw<
      { action_type: string; count: bigint; total_pnl: number }[]
    >`
      SELECT "actionType" AS action_type,
             COUNT(*)     AS count,
             COALESCE(SUM("pnlBtc"), 0) AS total_pnl
      FROM "AgentAction"
      WHERE "runId" = ${runId}
      GROUP BY "actionType"
      ORDER BY count DESC
    `;

    return {
      run,
      actionBreakdown: actionBreakdown.map((r) => ({
        actionType: r.action_type,
        count:      Number(r.count),
        totalPnlBtc: Number(r.total_pnl),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  /** Queue the model execution for an agent — returns immediately. */
  async executeRun(userId: string, id: string, dataFrom?: string, dataTo?: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, userId },
      include: { session: { select: { hyperparams: true } } },
    });
    if (!run) throw new NotFoundException('Agent not found');

    // BACKTEST agents can always be re-executed (processor resets state)
    const canRerun = run.runType === AgentRunType.BACKTEST;
    if (!canRerun && run.status !== AgentRunStatus.ACTIVE) {
      throw new BadRequestException(`Agent is not active (status: ${run.status})`);
    }
    if (!run.sessionId) {
      throw new BadRequestException('Agent has no linked training session — set sessionId when creating the agent');
    }

    // Resolve env settings: stored executionSettings → fallback to session hyperparams.env
    const stored = (run.executionSettings as Record<string, any>) ?? {};
    const sessionEnv = ((run.session?.hyperparams as any)?.env as Record<string, any>) ?? {};
    const { dataFrom: storedFrom, dataTo: storedTo, ...envPart } =
      Object.keys(stored).length > 0 ? stored : sessionEnv;

    const effectiveDataFrom = dataFrom ?? storedFrom;
    const effectiveDataTo   = dataTo   ?? storedTo;
    const envOverrides       = Object.keys(envPart).length > 0 ? envPart : undefined;

    const job = await this.agentRunQueue.add(
      'execute',
      { runId: id, dataFrom: effectiveDataFrom, dataTo: effectiveDataTo, envOverrides },
      { attempts: 2, backoff: { type: 'fixed', delay: 5_000 }, removeOnComplete: false, removeOnFail: false },
    );

    return { queued: true, runId: id, jobId: String(job.id) };
  }
}
