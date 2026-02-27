import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import * as crypto from 'crypto';

export function escapeMd(text: string): string {
  return text.replace(/[*_`[\]]/g, '\\$&');
}

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const webhookDomain = this.configService.get<string>('telegram.webhookDomain');
    const webhookPath = this.configService.get<string>('telegram.webhookPath');
    const isProduction = this.configService.get<boolean>('app.isProduction');
    const botToken = this.configService.get<string>('telegram.botToken');

    if (webhookDomain && isProduction && botToken) {
      try {
        const webhookUrl = `https://${webhookDomain}${webhookPath}`;
        const secretToken = crypto
          .createHash('sha256')
          .update(botToken)
          .digest('hex')
          .substring(0, 32);

        await this.bot.telegram.setWebhook(webhookUrl, { secret_token: secretToken });
        this.logger.log(`Webhook set to: ${webhookUrl}`);
      } catch (error) {
        this.logger.error(`Failed to set webhook: ${error.message}`);
      }
    }
  }

  async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, message);
    } catch (error) {
      this.logger.error(`Failed to send message to ${chatId}: ${error.message}`);
      throw error;
    }
  }

  async sendMarkdownMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
      });
    } catch (error) {
      this.logger.error(`Failed to send markdown message to ${chatId}: ${error.message}`);
      throw error;
    }
  }

  async sendErrorAlert(chatId: number, error: string): Promise<void> {
    const message = `⚠️ *Error*\n\n\`\`\`\n${error}\n\`\`\``;
    await this.sendMarkdownMessage(chatId, message);
  }

  async sendOrderAlert(
    chatId: number,
    orderId: string,
    instrumentName: string,
    direction: 'buy' | 'sell',
    amount: number,
    price: number,
    status: string,
  ): Promise<void> {
    const emoji = status === 'filled' ? '✅' : status === 'cancelled' ? '🚫' : '📋';
    const message =
      `${emoji} *Order ${status.charAt(0).toUpperCase() + status.slice(1)}*\n\n` +
      `Instrument: \`${instrumentName}\`\n` +
      `Direction: *${direction.toUpperCase()}*\n` +
      `Amount: \`${amount}\`\n` +
      `Price: \`${price}\`\n` +
      `Order ID: \`${orderId}\``;
    await this.sendMarkdownMessage(chatId, message);
  }
}
