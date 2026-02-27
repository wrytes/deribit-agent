import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBody,
  ApiSecurity,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@Controller('auth')
@ApiTags('Authentication')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify magic link and receive API key' })
  @ApiQuery({ name: 'token', required: true, description: '32-character magic link token' })
  @ApiResponse({ status: 200, description: 'API key created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired magic link token' })
  async verifyMagicLink(@Query('token') token: string) {
    const result = await this.authService.verifyMagicLink(token);
    return {
      apiKey: result.apiKey,
      expiresAt: result.expiresAt,
      message: 'API key created successfully',
    };
  }

  @Get('keys')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'List API keys' })
  @ApiResponse({ status: 200, description: 'List of API keys' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listApiKeys(@CurrentUser() user: User) {
    const keys = await this.authService.listApiKeys(user.id);
    return { keys };
  }

  @Post('revoke')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Revoke API key' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['keyId'],
      properties: { keyId: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 200, description: 'API key revoked successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async revokeApiKey(@CurrentUser() user: User, @Body('keyId') keyId: string) {
    await this.authService.revokeApiKey(user.id, keyId);
    return { message: 'API key revoked successfully' };
  }
}
