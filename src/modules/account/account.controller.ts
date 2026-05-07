import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiSecurity } from '@nestjs/swagger';
import { AccountService } from './account.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiKeyScope } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('account')
@ApiTags('account')
@UseGuards(ApiKeyGuard, ScopesGuard)
@ApiSecurity('api-key')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get('summary')
  @RequireScopes(ApiKeyScope.ACCOUNT_READ)
  @ApiOperation({ summary: 'Get account summary' })
  @ApiQuery({ name: 'currency', required: true })
  @ApiQuery({ name: 'extended', required: false, type: Boolean })
  async getAccountSummary(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query('extended') extended?: boolean,
  ) {
    return this.accountService.getAccountSummary(user.id, currency, extended);
  }

  @Get('summaries')
  @RequireScopes(ApiKeyScope.ACCOUNT_READ)
  @ApiOperation({ summary: 'Get account summaries (all currencies)' })
  @ApiQuery({ name: 'extended', required: false, type: Boolean })
  async getAccountSummaries(
    @CurrentUser() user: User,
    @Query('extended') extended?: boolean,
  ) {
    return this.accountService.getAccountSummaries(user.id, extended);
  }

  @Get('position')
  @RequireScopes(ApiKeyScope.ACCOUNT_READ)
  @ApiOperation({ summary: 'Get position' })
  @ApiQuery({ name: 'instrument_name', required: true })
  async getPosition(
    @CurrentUser() user: User,
    @Query('instrument_name') instrumentName: string,
  ) {
    return this.accountService.getPosition(user.id, instrumentName);
  }

  @Get('transaction-log')
  @RequireScopes(ApiKeyScope.ACCOUNT_READ)
  @ApiOperation({ summary: 'Get transaction log' })
  @ApiQuery({ name: 'currency', required: true })
  @ApiQuery({ name: 'start_timestamp', required: false, type: Number, description: 'Unix ms, defaults to 30 days ago' })
  @ApiQuery({ name: 'end_timestamp', required: false, type: Number, description: 'Unix ms, defaults to now' })
  async getTransactionLog(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query('start_timestamp') startTimestamp?: number,
    @Query('end_timestamp') endTimestamp?: number,
  ) {
    const now = Date.now();
    const start = startTimestamp ?? now - 30 * 24 * 60 * 60 * 1000;
    const end = endTimestamp ?? now;
    return this.accountService.getTransactionLog(user.id, currency, start, end);
  }

  @Get('portfolio-margins')
  @RequireScopes(ApiKeyScope.ACCOUNT_READ)
  @ApiOperation({ summary: 'Get portfolio margins' })
  @ApiQuery({ name: 'currency', required: true })
  async getPortfolioMargins(
    @CurrentUser() user: User,
    @Query('currency') currency: string,
    @Query() query: Record<string, any>,
  ) {
    const { currency: _c, ...rest } = query;
    return this.accountService.getPortfolioMargins(user.id, currency, rest);
  }
}
