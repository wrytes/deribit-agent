import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope, AgentRunStatus } from '@prisma/client';
import { AgentService } from './agent.service';
import { ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';

@ApiTags('agent')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard, ScopesGuard)
@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  @Post('runs')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Create a new agent run (live or paper)' })
  createRun(
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      sessionId?: string;
      name: string;
      currency: string;
      isLive?: boolean;
      initialCapitalBtc: number;
      notes?: string;
    },
  ) {
    return this.agentService.createRun({ userId: user.id, ...body });
  }

  @Get('runs')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'List your agent runs' })
  listRuns(
    @CurrentUser() user: { id: string },
    @Query('status') status?: AgentRunStatus,
  ) {
    return this.agentService.listRuns(user.id, status);
  }

  @Get('runs/:id')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Get agent run details with recent actions' })
  getRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.getRun(user.id, id);
  }

  @Get('runs/:id/summary')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Aggregated performance summary for a run' })
  getRunSummary(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.getRunSummary(user.id, id);
  }

  @Post('runs/:id/stop')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Stop an active agent run' })
  stopRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.stopRun(user.id, id);
  }

  @Post('runs/:id/pause')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Pause an active run' })
  pauseRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.pauseRun(user.id, id);
  }

  @Post('runs/:id/resume')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Resume a paused run' })
  resumeRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.resumeRun(user.id, id);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  @Post('runs/:id/actions')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Log an action taken by the running agent' })
  logAction(
    @Param('id') runId: string,
    @Body()
    body: {
      actionType: string;
      instrument?: string;
      quantity?: number;
      price?: number;
      orderId?: string;
      btcPrice?: number;
      delta?: number;
      ivRank?: number;
      executedPrice?: number;
      pnlBtc?: number;
      reason?: string;
    },
  ) {
    return this.agentService.logAction({ runId, ...body });
  }

  @Get('runs/:id/actions')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Get action log for an agent run' })
  getActions(
    @CurrentUser() user: { id: string },
    @Param('id') runId: string,
    @Query('limit') limit?: string,
  ) {
    return this.agentService.getRunActions(user.id, runId, limit ? parseInt(limit, 10) : undefined);
  }
}
