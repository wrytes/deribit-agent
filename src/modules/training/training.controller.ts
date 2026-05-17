import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { TrainingStatus } from '@prisma/client';
import { TrainingService, RiskProfile } from './training.service';

@ApiTags('training')
@ApiSecurity('api-key')
@Controller('training')
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  @Post('sessions')
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
        allowedActions: {
          type: 'array',
          items: { type: 'number' },
          example: [0, 1, 2, 3],
          description: 'Whitelist of action IDs the model may use during training (0 = hold)',
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
      currency?: string;
      dataFrom: string;
      dataTo: string;
      resolution?: string;
      algorithm?: string;
      allowedActions?: number[];
      expiryDaysMin?: number;
      expiryDaysMax?: number;
      rollDteThreshold?: number;
      riskProfile?: RiskProfile;
      hyperparams?: Record<string, any>;
      resumeFromModelId?: string;
    },
  ) {
    return this.trainingService.createSession({
      name:               body.name,
      description:        body.description,
      currency:           body.currency,
      dataFrom:           new Date(body.dataFrom),
      dataTo:             new Date(body.dataTo),
      resolution:         body.resolution,
      algorithm:          body.algorithm,
      allowedActions:     body.allowedActions,
      expiryDaysMin:      body.expiryDaysMin,
      expiryDaysMax:      body.expiryDaysMax,
      rollDteThreshold:   body.rollDteThreshold,
      riskProfile:        body.riskProfile,
      hyperparams:        body.hyperparams,
      resumeFromModelId:  body.resumeFromModelId,
    });
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List training sessions (optionally filter by status)' })
  @ApiQuery({ name: 'status', required: false, enum: TrainingStatus })
  listSessions(@Query('status') status?: TrainingStatus) {
    return this.trainingService.listSessions(status);
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Get a training session by ID' })
  getSession(@Param('id') id: string) {
    return this.trainingService.getSession(id);
  }

  @Post('sessions/:id/cancel')
  @ApiOperation({ summary: 'Cancel a queued or running training session (sets status to CANCELLED)' })
  cancelSession(@Param('id') id: string) {
    return this.trainingService.cancelSession(id);
  }

  @Patch('sessions/:id')
  @ApiOperation({ summary: 'Update session name or description' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string' },
        description: { type: 'string' },
      },
    },
  })
  updateSession(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.trainingService.updateSession(id, body);
  }

  @Delete('sessions/:id')
  @ApiOperation({
    summary: 'Hard-delete a session and all related data',
    description:
      'Cascades: removes the BullMQ job, all AgentRuns (and their AgentActions), ' +
      'the TrainedModel, and finally the TrainingSession itself.',
  })
  deleteSession(@Param('id') id: string) {
    return this.trainingService.deleteSession(id);
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  @Get('queue')
  @ApiOperation({ summary: 'BullMQ queue stats (waiting / active / completed / failed)' })
  queueStats() {
    return this.trainingService.getQueueStats();
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  @Get('models')
  @ApiOperation({ summary: 'List all trained models with their evaluation metrics' })
  listModels() {
    return this.trainingService.listModels();
  }

  @Get('models/:id')
  @ApiOperation({ summary: 'Get a trained model by ID' })
  getModel(@Param('id') id: string) {
    return this.trainingService.getModel(id);
  }

  @Patch('models/:id')
  @ApiOperation({ summary: 'Update model name' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    },
  })
  updateModel(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.trainingService.updateModel(id, body);
  }

  @Post('models')
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
