import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiSecurity, ApiParam } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { TradingBuyDto, TradingSellDto } from './trading.dto';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('trading')
@ApiTags('Trading')
@UseGuards(ApiKeyGuard, ScopesGuard)
@ApiSecurity('api-key')
export class TradingController {
  constructor(private readonly tradingService: TradingService) {}

  @Post('buy')
  @RequireScopes(ApiKeyScope.TRADING_WRITE)
  @ApiOperation({ summary: 'Place a buy order' })
  async buy(@CurrentUser() user: User, @Body() dto: TradingBuyDto) {
    return this.tradingService.buy(user.id, dto);
  }

  @Post('sell')
  @RequireScopes(ApiKeyScope.TRADING_WRITE)
  @ApiOperation({ summary: 'Place a sell order' })
  async sell(@CurrentUser() user: User, @Body() dto: TradingSellDto) {
    return this.tradingService.sell(user.id, dto);
  }

  @Delete('orders/:orderId')
  @RequireScopes(ApiKeyScope.TRADING_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an order' })
  @ApiParam({ name: 'orderId', type: String })
  async cancel(@CurrentUser() user: User, @Param('orderId') orderId: string) {
    return this.tradingService.cancel(user.id, orderId);
  }

  @Get('orders')
  @RequireScopes(ApiKeyScope.TRADING_READ)
  @ApiOperation({ summary: 'Get open orders by currency' })
  @ApiQuery({ name: 'currency', required: true })
  @ApiQuery({ name: 'kind', required: false })
  @ApiQuery({ name: 'type', required: false })
  async getOpenOrdersByCurrency(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query('kind') kind?: string,
    @Query('type') type?: string,
  ) {
    return this.tradingService.getOpenOrdersByCurrency(user.id, currency, kind, type);
  }

  @Get('orders/instrument/:name')
  @RequireScopes(ApiKeyScope.TRADING_READ)
  @ApiOperation({ summary: 'Get open orders by instrument' })
  @ApiParam({ name: 'name', type: String })
  @ApiQuery({ name: 'type', required: false })
  async getOpenOrdersByInstrument(
    @CurrentUser() user: User,
    @Param('name') name: string,
    @Query('type') type?: string,
  ) {
    return this.tradingService.getOpenOrdersByInstrument(user.id, name, type);
  }

  @Get('orders/:orderId')
  @RequireScopes(ApiKeyScope.TRADING_READ)
  @ApiOperation({ summary: 'Get order state' })
  @ApiParam({ name: 'orderId', type: String })
  async getOrderState(@CurrentUser() user: User, @Param('orderId') orderId: string) {
    return this.tradingService.getOrderState(user.id, orderId);
  }
}
