import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiSecurity, ApiParam } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('wallet')
@ApiTags('Wallet')
@UseGuards(ApiKeyGuard, ScopesGuard)
@ApiSecurity('api-key')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get('deposits')
  @RequireScopes(ApiKeyScope.WALLET_READ)
  @ApiOperation({ summary: 'Get deposits' })
  @ApiQuery({ name: 'currency', required: true })
  async getDeposits(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query() query: Record<string, any>,
  ) {
    const { currency: _c, ...rest } = query;
    return this.walletService.getDeposits(user.id, currency, rest);
  }

  @Get('withdrawals')
  @RequireScopes(ApiKeyScope.WALLET_READ)
  @ApiOperation({ summary: 'Get withdrawals' })
  @ApiQuery({ name: 'currency', required: true })
  async getWithdrawals(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query() query: Record<string, any>,
  ) {
    const { currency: _c, ...rest } = query;
    return this.walletService.getWithdrawals(user.id, currency, rest);
  }

  @Get('transfers')
  @RequireScopes(ApiKeyScope.WALLET_READ)
  @ApiOperation({ summary: 'Get transfers' })
  @ApiQuery({ name: 'currency', required: true })
  async getTransfers(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query() query: Record<string, any>,
  ) {
    const { currency: _c, ...rest } = query;
    return this.walletService.getTransfers(user.id, currency, rest);
  }

  @Get('deposit-address')
  @RequireScopes(ApiKeyScope.WALLET_READ)
  @ApiOperation({ summary: 'Get current deposit address' })
  @ApiQuery({ name: 'currency', required: true })
  async getCurrentDepositAddress(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
  ) {
    return this.walletService.getCurrentDepositAddress(user.id, currency);
  }

  @Post('deposit-address')
  @RequireScopes(ApiKeyScope.WALLET_WRITE)
  @ApiOperation({ summary: 'Create deposit address' })
  async createDepositAddress(
    @CurrentUser() user: User,
    @Body('currency') currency: string,
  ) {
    return this.walletService.createDepositAddress(user.id, currency);
  }

  @Post('withdraw')
  @RequireScopes(ApiKeyScope.WALLET_WRITE)
  @ApiOperation({ summary: 'Withdraw funds' })
  async withdraw(@CurrentUser() user: User, @Body() body: Record<string, any>) {
    return this.walletService.withdraw(user.id, body);
  }

  @Delete('transfers/:id')
  @RequireScopes(ApiKeyScope.WALLET_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel transfer by ID' })
  @ApiParam({ name: 'id', type: Number })
  @ApiQuery({ name: 'currency', required: true })
  async cancelTransferById(
    @CurrentUser() user: User,
    @Param('id', ParseIntPipe) id: number,
    @Query('currency') currency: string,
  ) {
    return this.walletService.cancelTransferById(user.id, id, currency);
  }

  @Delete('withdrawals/:id')
  @RequireScopes(ApiKeyScope.WALLET_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel withdrawal' })
  @ApiParam({ name: 'id', type: Number })
  @ApiQuery({ name: 'currency', required: true })
  async cancelWithdrawal(
    @CurrentUser() user: User,
    @Param('id', ParseIntPipe) id: number,
    @Query('currency') currency: string,
  ) {
    return this.walletService.cancelWithdrawal(user.id, id, currency);
  }
}
