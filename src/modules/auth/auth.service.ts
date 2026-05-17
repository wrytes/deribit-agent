import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';

/** Minimal auth service — user identity only for the Telegram bot.
 *  REST API auth is handled by WrytesAuthGuard via wrytes-api /auth/me. */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateUser(
    telegramId: bigint,
    telegramHandle?: string,
  ): Promise<{ id: string; isNew: boolean }> {
    let user = await this.prisma.user.findUnique({ where: { telegramId } });
    const isNew = !user;

    if (!user) {
      user = await this.prisma.user.create({ data: { telegramId, telegramHandle } });
    } else if (telegramHandle && user.telegramHandle !== telegramHandle) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data:  { telegramHandle },
      });
    }

    return { id: user.id, isNew };
  }

  findUserByTelegramId(telegramId: bigint) {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }
}
