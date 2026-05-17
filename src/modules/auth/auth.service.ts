import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';

/** Telegram-only user lookups. Users are created on first REST auth via WrytesAuthGuard. */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTelegramId(telegramId: bigint) {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  async linkTelegramId(userId: string, telegramId: bigint, telegramHandle?: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data:  { telegramId, telegramHandle },
    });
  }
}
