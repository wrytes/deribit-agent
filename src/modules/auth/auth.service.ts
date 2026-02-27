import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { ApiKeyScope } from '@prisma/client';
import { nanoid } from 'nanoid';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly BCRYPT_ROUNDS = 10;
  private readonly KEY_ID_LENGTH = 16;
  private readonly SECRET_LENGTH = 32;
  private readonly MAGIC_LINK_TOKEN_LENGTH = 32;
  private readonly MAGIC_LINK_EXPIRY_MINUTES = 15;

  constructor(private readonly prisma: PrismaService) {}

  async createMagicLink(
    userId: string,
    scopes: ApiKeyScope[] = [
      ApiKeyScope.ACCOUNT_READ,
      ApiKeyScope.MARKET_READ,
      ApiKeyScope.TRADING_READ,
    ],
  ): Promise<{ token: string; expiresAt: Date }> {
    this.logger.log(`Creating magic link for user ${userId}`);

    const token = nanoid(this.MAGIC_LINK_TOKEN_LENGTH);
    const expiresAt = new Date();
    expiresAt.setMinutes(
      expiresAt.getMinutes() + this.MAGIC_LINK_EXPIRY_MINUTES,
    );

    await this.prisma.magicLink.create({
      data: { userId, token, scopes, expiresAt },
    });

    return { token, expiresAt };
  }

  async verifyMagicLink(
    token: string,
  ): Promise<{ apiKey: string; expiresAt: Date | null }> {
    this.logger.log('Verifying magic link');

    const magicLink = await this.prisma.magicLink.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!magicLink) {
      throw new UnauthorizedException('Invalid magic link');
    }

    if (magicLink.usedAt) {
      throw new UnauthorizedException('Magic link already used');
    }

    if (magicLink.expiresAt < new Date()) {
      throw new UnauthorizedException('Magic link expired');
    }

    await this.prisma.magicLink.update({
      where: { id: magicLink.id },
      data: { usedAt: new Date() },
    });

    const { apiKey, expiresAt } = await this.createApiKey(
      magicLink.userId,
      magicLink.scopes,
    );

    return { apiKey, expiresAt };
  }

  async createApiKey(
    userId: string,
    scopes: ApiKeyScope[] = [
      ApiKeyScope.ACCOUNT_READ,
      ApiKeyScope.MARKET_READ,
      ApiKeyScope.TRADING_READ,
    ],
    expiresInDays?: number,
  ): Promise<{ apiKey: string; expiresAt: Date | null }> {
    this.logger.log(`Creating API key for user ${userId}`);

    const keyId = nanoid(this.KEY_ID_LENGTH);
    const secret = nanoid(this.SECRET_LENGTH);
    const secretHash = await bcrypt.hash(secret, this.BCRYPT_ROUNDS);

    let expiresAt: Date | null = null;
    if (expiresInDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    }

    await this.prisma.apiKey.create({
      data: { userId, keyId, secretHash, scopes, expiresAt },
    });

    const apiKey = `rw_prod_${keyId}.${secret}`;
    this.logger.log(
      `API key created for user ${userId} with scopes: ${scopes.join(', ')}`,
    );

    return { apiKey, expiresAt };
  }

  async revokeApiKey(userId: string, keyId: string): Promise<void> {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { userId, keyId },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.revokedAt) {
      this.logger.warn(`API key ${keyId} already revoked`);
      return;
    }

    await this.prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { revokedAt: new Date() },
    });
  }

  async listApiKeys(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      select: {
        id: true,
        keyId: true,
        scopes: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrCreateUser(
    telegramId: bigint,
    telegramHandle?: string,
  ): Promise<{ id: string; isNew: boolean }> {
    let user = await this.prisma.user.findUnique({ where: { telegramId } });
    const isNew = !user;

    if (!user) {
      user = await this.prisma.user.create({
        data: { telegramId, telegramHandle },
      });
    } else if (telegramHandle && user.telegramHandle !== telegramHandle) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramHandle },
      });
    }

    return { id: user.id, isNew };
  }

  async findUserByTelegramId(telegramId: bigint) {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }
}
