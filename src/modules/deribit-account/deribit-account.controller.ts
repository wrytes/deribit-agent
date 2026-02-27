import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { DeribitAccountService } from './deribit-account.service';
import { UpsertDeribitAccountDto } from './deribit-account.dto';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@Controller('deribit-account')
@ApiTags('Deribit Account')
@UseGuards(ApiKeyGuard)
@ApiSecurity('api-key')
export class DeribitAccountController {
  constructor(private readonly deribitAccountService: DeribitAccountService) {}

  @Post()
  @ApiOperation({ summary: 'Save or update Deribit credentials' })
  @ApiResponse({ status: 201, description: 'Credentials saved' })
  async upsert(@CurrentUser() user: User, @Body() dto: UpsertDeribitAccountDto) {
    return this.deribitAccountService.upsert(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get Deribit account info (never exposes secret)' })
  @ApiResponse({ status: 200, description: 'Deribit account info' })
  @ApiResponse({ status: 404, description: 'No credentials configured' })
  async get(@CurrentUser() user: User) {
    return this.deribitAccountService.get(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove Deribit credentials' })
  @ApiResponse({ status: 204, description: 'Credentials removed' })
  async remove(@CurrentUser() user: User) {
    await this.deribitAccountService.remove(user.id);
  }
}
