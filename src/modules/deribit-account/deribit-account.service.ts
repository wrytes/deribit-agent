import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { UpsertDeribitAccountDto } from './deribit-account.dto';

@Injectable()
export class DeribitAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
  ) {}

  async upsert(userId: string, dto: UpsertDeribitAccountDto) {
    const account = await this.prisma.deribitAccount.upsert({
      where: { userId },
      create: {
        userId,
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        baseUrl: dto.baseUrl ?? 'wss://www.deribit.com/ws/api/v2',
        isTestnet: dto.isTestnet ?? false,
      },
      update: {
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        ...(dto.baseUrl && { baseUrl: dto.baseUrl }),
        ...(dto.isTestnet !== undefined && { isTestnet: dto.isTestnet }),
      },
    });

    this.deribitClientService.evictClient(userId);

    return {
      id: account.id,
      clientId: account.clientId,
      baseUrl: account.baseUrl,
      isTestnet: account.isTestnet,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async get(userId: string) {
    const account = await this.prisma.deribitAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      throw new NotFoundException('No Deribit credentials configured');
    }

    return {
      id: account.id,
      clientId: account.clientId,
      baseUrl: account.baseUrl,
      isTestnet: account.isTestnet,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async remove(userId: string) {
    const account = await this.prisma.deribitAccount.findUnique({
      where: { userId },
    });

    if (!account) {
      throw new NotFoundException('No Deribit credentials configured');
    }

    this.deribitClientService.evictClient(userId);

    await this.prisma.deribitAccount.delete({ where: { userId } });
  }
}
