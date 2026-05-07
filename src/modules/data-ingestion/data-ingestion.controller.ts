import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { DataIngestionService, BackfillDto } from './data-ingestion.service';
import { ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';

@ApiTags('data')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('data')
export class DataIngestionController {
  constructor(private readonly dataIngestionService: DataIngestionService) {}

  // ---------------------------------------------------------------------------
  // Candles
  // ---------------------------------------------------------------------------

  @Get('candles/stats')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Candle coverage stats per instrument and resolution' })
  getCandleStats() {
    return this.dataIngestionService.getCandleStats();
  }

  @Get('candles')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Query stored OHLCV candles' })
  queryCandles(
    @Query('instrument') instrument: string,
    @Query('resolution') resolution: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dataIngestionService.queryCandles(
      instrument,
      resolution,
      from ? new Date(from) : undefined,
      to   ? new Date(to)   : undefined,
      limit ? parseInt(limit, 10) : 1000,
    );
  }

  @Post('candles/backfill')
  @RequireScopes(ApiKeyScope.DATA_WRITE)
  @ApiOperation({ summary: 'Backfill historical OHLCV candles from Deribit' })
  backfillCandles(
    @Body() body: { instrument: string; resolution: string; from: string; to?: string },
  ) {
    const dto: BackfillDto = {
      instrument: body.instrument,
      resolution: body.resolution,
      from: new Date(body.from),
      to:   body.to ? new Date(body.to) : undefined,
    };
    return this.dataIngestionService.backfillCandles(dto);
  }

  @Post('candles/ingest-latest')
  @RequireScopes(ApiKeyScope.DATA_WRITE)
  @ApiOperation({ summary: 'Append latest candles since last stored timestamp' })
  ingestLatest(
    @Body() body: { instrument: string; resolution: string },
  ) {
    return this.dataIngestionService
      .ingestLatestCandles(body.instrument, body.resolution)
      .then((inserted) => ({ instrument: body.instrument, resolution: body.resolution, inserted }));
  }

  // ---------------------------------------------------------------------------
  // Options snapshots
  // ---------------------------------------------------------------------------

  @Get('options/stats')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Options snapshot coverage stats' })
  getOptionStats() {
    return this.dataIngestionService.getOptionSnapshotStats();
  }

  @Get('options')
  @RequireScopes(ApiKeyScope.DATA_READ)
  @ApiOperation({ summary: 'Query stored option IV surface snapshots' })
  queryOptions(
    @Query('currency') currency: string,
    @Query('expiry') expiry?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dataIngestionService.queryOptionSnapshots(
      currency,
      expiry,
      from ? new Date(from) : undefined,
      to   ? new Date(to)   : undefined,
      limit ? parseInt(limit, 10) : 500,
    );
  }

  @Post('options/snapshot')
  @RequireScopes(ApiKeyScope.DATA_WRITE)
  @ApiOperation({ summary: 'Capture a live options chain snapshot for BTC or ETH' })
  snapshotOptions(@Body() body: { currency: 'BTC' | 'ETH' }) {
    return this.dataIngestionService.snapshotOptionChain(body.currency);
  }
}
