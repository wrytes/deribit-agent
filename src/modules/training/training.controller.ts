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
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { ApiKeyScope, TrainingStatus } from '@prisma/client';
import { TrainingService } from './training.service';
import { ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';

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
  @ApiOperation({ summary: 'List training sessions' })
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
  @ApiOperation({ summary: 'Training queue stats' })
  queueStats() {
    return this.trainingService.getQueueStats();
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  @Get('models')
  @RequireScopes(ApiKeyScope.TRAINING_READ)
  @ApiOperation({ summary: 'List all trained models' })
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
