import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitApiClient, GrantType, RequestQuery } from '@wrytlabs/deribit-api-client';

const WS_OPEN = 1; // WebSocket.OPEN

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

    await this.waitForSocketOpen(client);

    this.clients.set(userId, client);
    this.logger.log(`Created Deribit client for user ${userId}`);
    return client;
  }

  /**
   * Poll the underlying WebSocket until it reaches OPEN state.
   * Throws GatewayTimeoutException if it doesn't open within timeoutMs.
   */
  private async waitForSocketOpen(
    client: DeribitApiClient,
    timeoutMs = 8000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const socket = (client as any).socket as { readyState?: number } | undefined;
      if (socket?.readyState === WS_OPEN) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new GatewayTimeoutException(
      'Deribit WebSocket did not connect within timeout',
    );
  }

  /**
   * Unwrap a Deribit response: throw BadGatewayException if Deribit returned
   * an error object, otherwise return the result value.
   */
  unwrap<T>(response: RequestQuery<T>): T {
    if ('error' in response) {
      throw new BadGatewayException(
        `Deribit error ${response.error.code}: ${response.error.message}`,
      );
    }
    return response.result;
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
