import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKeyHeader = request.headers['x-api-key'];

    if (!apiKeyHeader) {
      throw new UnauthorizedException('API key is required');
    }

    const keyMatch = apiKeyHeader.match(
      /^rw_prod_([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/,
    );

    if (!keyMatch) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const [, keyId, secret] = keyMatch;

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyId },
      include: { user: true },
    });

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKey.revokedAt) {
      throw new UnauthorizedException('API key has been revoked');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const isValid = await bcrypt.compare(secret, apiKey.secretHash);

    if (!isValid) {
      throw new UnauthorizedException('Invalid API key');
    }

    this.prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => {
        this.logger.error(`Failed to update lastUsedAt: ${err.message}`);
      });

    request.user = apiKey.user;
    request.apiKey = apiKey;

    return true;
  }
}
