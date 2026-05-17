import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../core/database/prisma.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import {
  OrderFilledEvent,
  OrderCancelledEvent,
  TradeErrorEvent,
} from '../events/notification.events';

@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
  ) {}

  @OnEvent('order.filled')
  async handleOrderFilled(event: OrderFilledEvent) {
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });

    if (!user || !user.notifyErrors || !user.telegramId) return;

    const chatId = Number(user.telegramId);
    const message =
      `✅ *Order Filled*\n\n` +
      `Instrument: \`${event.instrumentName}\`\n` +
      `Direction: *${event.direction.toUpperCase()}*\n` +
      `Amount: \`${event.amount}\`\n` +
      `Price: \`${event.price}\`\n` +
      `Order ID: \`${event.orderId}\``;

    await this.telegramService.sendMarkdownMessage(chatId, message).catch((err) => {
      this.logger.error(`Failed to send order filled notification: ${err.message}`);
    });
  }

  @OnEvent('order.cancelled')
  async handleOrderCancelled(event: OrderCancelledEvent) {
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });

    if (!user || !user.notifyErrors || !user.telegramId) return;

    const chatId = Number(user.telegramId);
    const message =
      `🚫 *Order Cancelled*\n\n` +
      `Instrument: \`${event.instrumentName}\`\n` +
      `Order ID: \`${event.orderId}\``;

    await this.telegramService.sendMarkdownMessage(chatId, message).catch((err) => {
      this.logger.error(`Failed to send order cancelled notification: ${err.message}`);
    });
  }

  @OnEvent('trade.error')
  async handleTradeError(event: TradeErrorEvent) {
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
    });

    if (!user || !user.notifyErrors || !user.telegramId) return;

    const chatId = Number(user.telegramId);
    await this.telegramService.sendErrorAlert(chatId, event.error).catch((err) => {
      this.logger.error(`Failed to send error notification: ${err.message}`);
    });
  }
}
