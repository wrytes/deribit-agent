import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope, AgentRunStatus, AgentRunType } from '@prisma/client';
import { AgentService, SaveSettingsDto } from './agent.service';

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
  @ApiOperation({ summary: 'Create a new agent run (backtest, paper, or live)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'currency', 'initialCapitalBtc'],
      properties: {
        sessionId:         { type: 'string', example: 'cuid...', description: 'Trained model session to use' },
        name:              { type: 'string', example: 'btc-paper-run-1' },
        currency:          { type: 'string', enum: ['BTC', 'ETH'], example: 'BTC' },
        runType:           { type: 'string', enum: ['BACKTEST', 'PAPER', 'LIVE'], example: 'PAPER', description: 'BACKTEST = historical replay only, PAPER = live data without real orders, LIVE = real Deribit orders' },
        deribitAccountId:  { type: 'string', example: 'cuid...', description: 'Required for LIVE runs — ID from GET /deribit-account' },
        initialCapitalBtc: { type: 'number', example: 0.1 },
        notes:             { type: 'string', example: 'First paper run with btc-ppo-v1' },
      },
    },
  })
  createRun(
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      sessionId?: string;
      name: string;
      currency: string;
      runType?: AgentRunType;
      deribitAccountId?: string;
      initialCapitalBtc: number;
      notes?: string;
    },
  ) {
    return this.agentService.createRun({ userId: user.id, ...body });
  }

  @Patch('runs/:id')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Update agent name or notes' })
  updateRun(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: { name?: string; notes?: string },
  ) {
    return this.agentService.updateRun(user.id, id, body);
  }

  @Delete('runs/:id')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Hard-delete an agent run and all its actions' })
  deleteRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.deleteRun(user.id, id);
  }

  @Get('runs')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'List your agent runs' })
  @ApiQuery({ name: 'status', required: false, enum: AgentRunStatus })
  listRuns(
    @CurrentUser() user: { id: string },
    @Query('status') status?: AgentRunStatus,
  ) {
    return this.agentService.listRuns(user.id, status);
  }

  @Get('runs/:id')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Get agent run details with last 100 actions' })
  getRun(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.getRun(user.id, id);
  }

  @Get('runs/:id/summary')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Aggregated action breakdown and P&L for a run' })
  getRunSummary(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.agentService.getRunSummary(user.id, id);
  }

  @Post('runs/:id/stop')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Stop an active or paused agent run' })
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

  @Patch('runs/:id/settings')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Save per-agent execution settings (persisted in DB, used on next execute)' })
  saveSettings(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: SaveSettingsDto,
  ) {
    return this.agentService.saveSettings(user.id, id, body);
  }

  @Post('runs/:id/execute')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({
    summary: 'Queue the model execution for an agent run — returns immediately',
    description:
      'Env settings come from run.executionSettings (saved via PATCH /runs/:id/settings), ' +
      'falling back to the session hyperparams.env defaults. ' +
      'Adds an execute job to the agent-run BullMQ queue.',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        dataFrom: { type: 'string', format: 'date-time', description: 'Override data start (defaults to stored dataFrom)' },
        dataTo:   { type: 'string', format: 'date-time', description: 'Override data end (defaults to stored dataTo)' },
      },
    },
  })
  executeRun(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: { dataFrom?: string; dataTo?: string } = {},
  ) {
    return this.agentService.executeRun(user.id, id, body.dataFrom, body.dataTo);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  @Post('runs/:id/actions')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Log a model action (called by the agent process)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['actionType'],
      properties: {
        actionType:    { type: 'string', example: 'open', description: 'settlement_init | settlement_unrealized | settlement_expired | open | close' },
        timestamp:     { type: 'string', format: 'date-time', description: 'Historical timestamp for backtest actions; defaults to now' },
        instrument:    { type: 'string', example: 'BTC-28MAR25-70000-C' },
        quantity:      { type: 'number', example: 0.1 },
        price:         { type: 'number', example: 0.002 },
        orderId:       { type: 'string', example: 'deribit-order-id' },
        btcPrice:      { type: 'number', example: 65000 },
        delta:         { type: 'number', example: -0.35 },
        ivRank:        { type: 'number', example: 72.5 },
        executedPrice: { type: 'number', example: 0.0019 },
        pnlBtc:        { type: 'number', example: 0.00012 },
        reason:        { type: 'string', example: 'IV rank > 70, sell OTM strangle' },
      },
    },
  })
  logAction(
    @Param('id') runId: string,
    @Body()
    body: {
      actionType: string;
      timestamp?: string;
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
    const { timestamp, ...rest } = body;
    return this.agentService.logAction({
      runId,
      ...rest,
      ...(timestamp ? { timestamp: new Date(timestamp) } : {}),
    });
  }

  @Post('runs/:id/actions/batch')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({ summary: 'Bulk-insert actions from a completed backtest episode (single transaction)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['actionType'],
            properties: {
              actionType: { type: 'string' },
              timestamp:  { type: 'string', format: 'date-time' },
              instrument: { type: 'string' },
              btcPrice:   { type: 'number' },
              delta:      { type: 'number' },
              ivRank:     { type: 'number' },
              pnlBtc:     { type: 'number' },
              reason:     { type: 'string' },
            },
          },
        },
      },
    },
  })
  logActionBatch(
    @Param('id') runId: string,
    @Body() body: { actions: any[] },
  ) {
    return this.agentService.logActionBatch(
      runId,
      body.actions.map((a) => ({
        ...a,
        ...(a.timestamp ? { timestamp: new Date(a.timestamp) } : {}),
      })),
    );
  }

  @Get('runs/:id/actions')
  @RequireScopes(ApiKeyScope.AGENT_READ)
  @ApiOperation({ summary: 'Get the action log for an agent run (newest first)' })
  getActions(
    @CurrentUser() user: { id: string },
    @Param('id') runId: string,
    @Query('limit') limit?: string,
  ) {
    return this.agentService.getRunActions(user.id, runId, limit ? parseInt(limit, 10) : undefined);
  }
}
