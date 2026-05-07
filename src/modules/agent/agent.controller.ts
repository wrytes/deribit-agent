import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope, AgentRunStatus } from '@prisma/client';
import { AgentService } from './agent.service';

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
  @ApiOperation({ summary: 'Create a new agent run (paper or live)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'currency', 'initialCapitalBtc'],
      properties: {
        sessionId:         { type: 'string', example: 'cuid...', description: 'Trained model session to use' },
        name:              { type: 'string', example: 'btc-paper-run-1' },
        currency:          { type: 'string', enum: ['BTC', 'ETH'], example: 'BTC' },
        isLive:            { type: 'boolean', example: false, description: 'false = paper trading, true = live orders' },
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

  @Post('runs/:id/execute')
  @RequireScopes(ApiKeyScope.AGENT_WRITE)
  @ApiOperation({
    summary: 'Execute the model on historical data via the Python trainer sidecar',
    description:
      'Calls POST /run on TRAINER_URL. Blocks until the episode completes. ' +
      'Actions are logged back via NESTJS_API_KEY. Requires NESTJS_URL + NESTJS_API_KEY on the trainer.',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        dataFrom: { type: 'string', format: 'date-time', description: 'Override data start (defaults to session.dataFrom)' },
        dataTo:   { type: 'string', format: 'date-time', description: 'Override data end (defaults to now)' },
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
        actionType:    { type: 'string', example: 'sell_call', description: 'hold | sell_call | sell_put | buy_call | buy_put | close | hedge' },
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
