import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { DataIngestionService, TRACKED_INSTRUMENTS } from './data-ingestion.service';

@ApiTags('data')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('data')
export class DataIngestionController {
  constructor(private readonly dataIngestionService: DataIngestionService) {}

  @Get('status')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Pipeline status — tracked instruments and DB coverage' })
  async getStatus() {
    const [candles, options] = await Promise.all([
      this.dataIngestionService.getCandleStats(),
      this.dataIngestionService.getOptionSnapshotStats(),
    ]);
    return { tracked: TRACKED_INSTRUMENTS, candles, options };
  }

  @Get('candles')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Query stored OHLCV candles' })
  @ApiQuery({ name: 'instrument', example: 'BTC-PERPETUAL' })
  @ApiQuery({ name: 'resolution', example: '1D' })
  @ApiQuery({ name: 'from',  required: false, example: '2024-01-01T00:00:00.000Z' })
  @ApiQuery({ name: 'to',    required: false, example: '2025-01-01T00:00:00.000Z' })
  @ApiQuery({ name: 'limit', required: false, example: '1000' })
  queryCandles(
    @Query('instrument') instrument: string,
    @Query('resolution') resolution: string,
    @Query('from')  from?: string,
    @Query('to')    to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dataIngestionService.queryCandles(
      instrument,
      resolution,
      from  ? new Date(from)      : undefined,
      to    ? new Date(to)        : undefined,
      limit ? parseInt(limit, 10) : 1000,
    );
  }

  @Get('options')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Query stored option IV surface snapshots' })
  @ApiQuery({ name: 'currency', example: 'BTC' })
  @ApiQuery({ name: 'expiry', required: false, example: '28MAR25' })
  @ApiQuery({ name: 'from',   required: false, example: '2024-01-01T00:00:00.000Z' })
  @ApiQuery({ name: 'to',     required: false, example: '2025-01-01T00:00:00.000Z' })
  @ApiQuery({ name: 'limit',  required: false, example: '500' })
  queryOptions(
    @Query('currency') currency: string,
    @Query('expiry') expiry?: string,
    @Query('from')  from?: string,
    @Query('to')    to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dataIngestionService.queryOptionSnapshots(
      currency,
      expiry,
      from  ? new Date(from)      : undefined,
      to    ? new Date(to)        : undefined,
      limit ? parseInt(limit, 10) : 500,
    );
  }
}
