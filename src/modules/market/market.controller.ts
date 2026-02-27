import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiSecurity } from '@nestjs/swagger';
import { MarketService } from './market.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('market')
@ApiTags('Market')
@UseGuards(ApiKeyGuard, ScopesGuard)
@ApiSecurity('api-key')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Get('book-summary/currency')
  @RequireScopes(ApiKeyScope.MARKET_READ)
  @ApiOperation({ summary: 'Get book summary by currency' })
  @ApiQuery({ name: 'currency', required: true })
  @ApiQuery({ name: 'kind', required: false })
  async getBookSummaryByCurrency(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query('kind') kind?: string,
  ) {
    return this.marketService.getBookSummaryByCurrency(user.id, currency, kind);
  }

  @Get('book-summary/instrument')
  @RequireScopes(ApiKeyScope.MARKET_READ)
  @ApiOperation({ summary: 'Get book summary by instrument' })
  @ApiQuery({ name: 'name', required: true })
  async getBookSummaryByInstrument(
    @CurrentUser() user: User,
    @Query('name') name: string,
  ) {
    return this.marketService.getBookSummaryByInstrument(user.id, name);
  }

  @Get('currencies')
  @RequireScopes(ApiKeyScope.MARKET_READ)
  @ApiOperation({ summary: 'Get currencies' })
  async getCurrencies(@CurrentUser() user: User) {
    return this.marketService.getCurrencies(user.id);
  }

  @Get('delivery-prices')
  @RequireScopes(ApiKeyScope.MARKET_READ)
  @ApiOperation({ summary: 'Get delivery prices' })
  @ApiQuery({ name: 'index_name', required: true })
  async getDeliveryPrices(
    @CurrentUser() user: User,
    @Query('index_name') indexName: string,
    @Query() query: Record<string, any>,
  ) {
    const { index_name: _i, ...rest } = query;
    return this.marketService.getDeliveryPrices(user.id, indexName, rest);
  }
}
