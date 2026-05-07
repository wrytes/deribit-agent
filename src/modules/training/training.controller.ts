import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { ApiKeyScope, TrainingStatus } from '@prisma/client';
import { TrainingService, RiskProfile } from './training.service';

@ApiTags('training')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('training')
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  @Post('sessions')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({ summary: 'Create and queue a new training session' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'currency', 'dataFrom', 'dataTo'],
      properties: {
        name:        { type: 'string', example: 'btc-ppo-v1' },
        description: { type: 'string', example: 'Baseline PPO on 1-year BTC daily data' },
        currency:    { type: 'string', enum: ['BTC', 'ETH'], example: 'BTC' },
        dataFrom:    { type: 'string', format: 'date-time', example: '2024-01-01T00:00:00.000Z' },
        dataTo:      { type: 'string', format: 'date-time', example: '2025-01-01T00:00:00.000Z' },
        resolution:  { type: 'string', example: '1D', description: 'Candle resolution used for training data' },
        algorithm:   { type: 'string', enum: ['PPO', 'DQN', 'A2C'], example: 'PPO' },
        allowedStrategies: {
          type: 'array',
          items: { type: 'string' },
          example: ['STRANGLE', 'DELTA_NEUTRAL'],
          description: 'Whitelist of strategy/action types the model may use during training. Options: STRANGLE, DELTA_NEUTRAL, COVERED_CALL, CASH_SECURED_PUT, IRON_CONDOR, STRADDLE',
        },
        riskProfile: {
          type: 'object',
          description: 'High-level risk parameters translated into env hyperparams',
          properties: {
            maxDrawdown:     { type: 'number', example: 0.20, description: '0.0–1.0 — episode ends when drawdown exceeds this' },
            aggressionLevel: { type: 'number', example: 0.5, description: '0.0 (very passive) to 1.0 (very aggressive) — scales position size, exploration, and loss penalty' },
          },
        },
        hyperparams: {
          type: 'object',
          example: { training: { total_timesteps: 500000, learning_rate: 0.003 } },
          description: 'Low-level env/training overrides merged after riskProfile is applied',
        },
      },
    },
  })
  createSession(
    @Body()
    body: {
      name: string;
      description?: string;
      currency: string;
      dataFrom: string;
      dataTo: string;
      resolution?: string;
      algorithm?: string;
      allowedStrategies?: string[];
      riskProfile?: RiskProfile;
      hyperparams?: Record<string, any>;
    },
  ) {
    return this.trainingService.createSession({
      name:              body.name,
      description:       body.description,
      currency:          body.currency,
      dataFrom:          new Date(body.dataFrom),
      dataTo:            new Date(body.dataTo),
      resolution:        body.resolution,
      algorithm:         body.algorithm,
      allowedStrategies: body.allowedStrategies,
      riskProfile:       body.riskProfile,
      hyperparams:       body.hyperparams,
    });
  }

  @Get('sessions')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'List training sessions (optionally filter by status)' })
  @ApiQuery({ name: 'status', required: false, enum: TrainingStatus })
  listSessions(@Query('status') status?: TrainingStatus) {
    return this.trainingService.listSessions(status);
  }

  @Get('sessions/:id')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'Get a training session by ID' })
  getSession(@Param('id') id: string) {
    return this.trainingService.getSession(id);
  }

  @Post('sessions/:id/cancel')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({ summary: 'Cancel a queued or running training session (sets status to CANCELLED)' })
  cancelSession(@Param('id') id: string) {
    return this.trainingService.cancelSession(id);
  }

  @Delete('sessions/:id')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({
    summary: 'Hard-delete a session and all related data',
    description:
      'Cascades: removes the BullMQ job, all AgentRuns (and their AgentActions), ' +
      'the TrainedModel, and finally the TrainingSession itself.',
  })
  deleteSession(@Param('id') id: string) {
    return this.trainingService.deleteSession(id);
  }

  @Post('sessions/:id/callback')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({
    summary: 'Trainer sidecar callback — marks session completed/failed and registers model',
    description: 'Called by the Python trainer when training finishes. Requires TRAINING_WRITE scope.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        result: {
          type: 'object',
          properties: {
            total_timesteps: { type: 'number' },
            final_reward:    { type: 'number' },
            model_path:      { type: 'string' },
            model_name:      { type: 'string' },
            size_bytes:      { type: 'number' },
            mean_reward:     { type: 'number' },
            std_reward:      { type: 'number' },
            sharpe_ratio:    { type: 'number' },
            max_drawdown:    { type: 'number' },
            win_rate:        { type: 'number' },
          },
        },
        error: { type: 'string', description: 'Set when training failed' },
      },
    },
  })
  trainerCallback(
    @Param('id') id: string,
    @Body() body: { result?: Record<string, any>; error?: string },
  ) {
    return this.trainingService.handleTrainerCallback(id, body.result, body.error);
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  @Get('queue')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'BullMQ queue stats (waiting / active / completed / failed)' })
  queueStats() {
    return this.trainingService.getQueueStats();
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  @Get('models')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'List all trained models with their evaluation metrics' })
  listModels() {
    return this.trainingService.listModels();
  }

  @Get('models/:id')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'Get a trained model by ID' })
  getModel(@Param('id') id: string) {
    return this.trainingService.getModel(id);
  }

  @Post('models')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({ summary: 'Manually register an externally trained model' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['sessionId', 'name', 'storagePath'],
      properties: {
        sessionId:   { type: 'string', example: 'cuid...' },
        name:        { type: 'string', example: 'btc-ppo-v1' },
        storagePath: { type: 'string', example: '/app/models/btc-ppo-v1.zip' },
        storageType: { type: 'string', enum: ['local', 's3'], example: 'local' },
        sizeBytes:   { type: 'number', example: 524288 },
        meanReward:  { type: 'number', example: 1.12 },
        stdReward:   { type: 'number', example: 0.3 },
        sharpeRatio: { type: 'number', example: 1.8 },
        maxDrawdown: { type: 'number', example: 0.12 },
        winRate:     { type: 'number', example: 0.62 },
        metadata:    { type: 'object', example: {} },
      },
    },
  })
  registerModel(
    @Body()
    body: {
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
    },
  ) {
    return this.trainingService.registerModel(body);
  }
}
