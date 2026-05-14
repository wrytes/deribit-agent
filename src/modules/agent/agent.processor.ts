import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AgentRunStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { AGENT_RUN_QUEUE } from './agent.service';

export interface AgentRunJobData {
  runId: string;
  jobType?: 'execute' | 'paper-tick';
  dataFrom?: string;
  dataTo?: string;
  envOverrides?: Record<string, unknown>;
}

@Processor(AGENT_RUN_QUEUE)
export class AgentRunProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentRunProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<AgentRunJobData>): Promise<void> {
    const { runId, jobType, dataFrom, dataTo, envOverrides } = job.data;

    if (jobType === 'paper-tick') {
      return this.processPaperTick(runId);
    }
    return this.processBacktest(runId, dataFrom, dataTo, envOverrides);
  }

  private async processBacktest(
    runId: string,
    dataFrom?: string,
    dataTo?: string,
    envOverrides?: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log(`Backtest run ${runId}`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { this.logger.warn(`Agent ${runId} not found — skipping`); return; }
    if (!run.sessionId) { this.logger.warn(`Agent ${runId} has no sessionId — skipping`); return; }

    await this.prisma.$transaction([
      this.prisma.agentAction.deleteMany({ where: { runId } }),
      this.prisma.agentRun.update({
        where: { id: runId },
        data:  {
          currentCapitalBtc: run.initialCapitalBtc,
          realizedPnlBtc:    0,
          totalActions:      0,
          status:            AgentRunStatus.ACTIVE,
        },
      }),
    ]);

    const trainerUrl = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    try {
      const mergedEnvOverrides = {
        initial_margin_btc: Number(run.initialCapitalBtc),
        ...(envOverrides ?? {}),
      };

      const response = await fetch(`${trainerUrl}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          run_id:        runId,
          session_id:    run.sessionId,
          ...(dataFrom       ? { data_from:     dataFrom          } : {}),
          ...(dataTo         ? { data_to:       dataTo            } : {}),
          env_overrides: mergedEnvOverrides,
        }),
        signal: AbortSignal.timeout(3_600_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer responded ${response.status}: ${text}`);
      }

      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.COMPLETED, stoppedAt: new Date() },
      });

      this.logger.log(`Backtest ${runId} completed`);
    } catch (err) {
      this.logger.error(`Backtest ${runId} failed: ${(err as Error).message}`);
      await this.prisma.agentRun.update({
        where: { id: runId },
        data:  { status: AgentRunStatus.ERROR, stoppedAt: new Date() },
      }).catch(() => null);
      throw err;
    }
  }

  private async processPaperTick(runId: string): Promise<void> {
    this.logger.log(`Paper tick ${runId}`);

    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) { this.logger.warn(`Agent ${runId} not found — skipping`); return; }
    if (run.status !== AgentRunStatus.ACTIVE) {
      this.logger.warn(`Agent ${runId} is not ACTIVE (${run.status}) — skipping paper tick`);
      return;
    }

    const paperState = run.paperState as Record<string, unknown> | null;
    const today = new Date().toISOString().split('T')[0];
    if (paperState?.lastTickDate === today) {
      this.logger.log(`Paper run ${runId} already ticked today — skipping`);
      return;
    }

    const trainerUrl = this.config.get<string>('TRAINER_URL') ?? 'http://localhost:8000';

    try {
      const response = await fetch(`${trainerUrl}/paper/tick`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ run_id: runId }),
        signal:  AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Trainer responded ${response.status}: ${text}`);
      }

      const result = await response.json() as { terminated?: boolean };
      this.logger.log(`Paper tick ${runId} done — terminated=${result.terminated}`);

      if (result.terminated) {
        await this.prisma.agentRun.update({
          where: { id: runId },
          data:  { status: AgentRunStatus.STOPPED, stoppedAt: new Date() },
        });
      }
    } catch (err) {
      this.logger.error(`Paper tick ${runId} failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
