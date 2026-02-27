import {
  Controller,
  Post,
  Body,
  Logger,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import * as crypto from 'crypto';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);
  private readonly webhookSecret: string;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
  ) {
    const botToken = this.configService.get<string>('telegram.botToken');
    this.webhookSecret = botToken
      ? crypto.createHash('sha256').update(botToken).digest('hex').substring(0, 32)
      : '';
  }

  @Post('webhook')
  async handleWebhook(
    @Body() update: any,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ) {
    if (!secretToken || secretToken !== this.webhookSecret) {
      this.logger.warn('Rejected webhook request with invalid secret token');
      throw new UnauthorizedException('Invalid secret token');
    }

    try {
      await this.bot.handleUpdate(update);
      return { ok: true };
    } catch (error) {
      this.logger.error(`Webhook error: ${error.message}`, error.stack);
      return { ok: false, error: error.message };
    }
  }
}
