import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitApiClient, GrantType } from '@wrytlabs/deribit-api-client';

@Injectable()
export class DeribitClientService implements OnModuleDestroy {
  private readonly logger = new Logger(DeribitClientService.name);
  private readonly clients = new Map<string, DeribitApiClient>();

  constructor(private readonly prisma: PrismaService) {}

  async getClient(userId: string): Promise<DeribitApiClient> {
    if (this.clients.has(userId)) return this.clients.get(userId)!;

    const account = await this.prisma.deribitAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      throw new NotFoundException(
        'No Deribit credentials configured. Use POST /deribit-account to add them.',
      );
    }

    const client = new DeribitApiClient({
      type: GrantType.client_credentials,
      baseUrl: account.baseUrl,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
    });

    this.clients.set(userId, client);
    this.logger.log(`Created Deribit client for user ${userId}`);
    return client;
  }

  evictClient(userId: string) {
    const client = this.clients.get(userId);
    if (client) {
      client.close();
      this.clients.delete(userId);
      this.logger.log(`Evicted Deribit client for user ${userId}`);
    }
  }

  onModuleDestroy() {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.logger.log('All Deribit clients closed');
  }
}
