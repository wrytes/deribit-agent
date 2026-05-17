import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
import { CreateDeribitAccountDto, UpdateDeribitAccountDto } from './deribit-account.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@Controller('deribit-account')
@ApiTags('deribit-account')
@ApiSecurity('api-key')
export class DeribitAccountController {
  constructor(private readonly deribitAccountService: DeribitAccountService) {}

  @Get()
  @ApiOperation({ summary: 'List all Deribit accounts (secrets never exposed)' })
  @ApiResponse({ status: 200, description: 'List of accounts' })
  list(@CurrentUser() user: User) {
    return this.deribitAccountService.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a Deribit account' })
  @ApiResponse({ status: 201, description: 'Account created' })
  create(@CurrentUser() user: User, @Body() dto: CreateDeribitAccountDto) {
    return this.deribitAccountService.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a Deribit account' })
  @ApiResponse({ status: 200, description: 'Account updated' })
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateDeribitAccountDto) {
    return this.deribitAccountService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a Deribit account (blocked if active runs reference it)' })
  @ApiResponse({ status: 204, description: 'Account removed' })
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.deribitAccountService.remove(user.id, id);
  }

  @Post(':id/default')
  @ApiOperation({ summary: 'Set an account as the default for live runs' })
  @ApiResponse({ status: 200, description: 'Default updated' })
  setDefault(@CurrentUser() user: User, @Param('id') id: string) {
    return this.deribitAccountService.setDefault(user.id, id);
  }
}
