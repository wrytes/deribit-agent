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
import { TrainingService } from './training.service';

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
        hyperparams: {
          type: 'object',
          example: { training: { total_timesteps: 500000, learning_rate: 0.003 } },
          description: 'Nested env/training overrides — merged with defaults in the trainer',
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
      hyperparams?: Record<string, any>;
    },
  ) {
    return this.trainingService.createSession({
      name:        body.name,
      description: body.description,
      currency:    body.currency,
      dataFrom:    new Date(body.dataFrom),
      dataTo:      new Date(body.dataTo),
      resolution:  body.resolution,
      algorithm:   body.algorithm,
      hyperparams: body.hyperparams,
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

  @Delete('sessions/:id')
  @RequireScopes(ApiKeyScope.TRAINING_WRITE)
  @ApiOperation({ summary: 'Cancel a queued or running training session' })
  cancelSession(@Param('id') id: string) {
    return this.trainingService.cancelSession(id);
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
