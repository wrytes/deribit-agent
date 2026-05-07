import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { CreateDeribitAccountDto, UpdateDeribitAccountDto } from './deribit-account.dto';

const SAFE_FIELDS = {
  id: true,
  userId: true,
  label: true,
  clientId: true,
  baseUrl: true,
  isTestnet: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class DeribitAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deribitClientService: DeribitClientService,
  ) {}

  async list(userId: string) {
    return this.prisma.deribitAccount.findMany({
      where: { userId },
      select: SAFE_FIELDS,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: string, dto: CreateDeribitAccountDto) {
    if (dto.isDefault) {
      await this.prisma.deribitAccount.updateMany({
        where: { userId },
        data: { isDefault: false },
      });
    }

    const account = await this.prisma.deribitAccount.create({
      data: {
        userId,
        label: dto.label ?? 'default',
        clientId: dto.clientId,
        clientSecret: dto.clientSecret,
        baseUrl: dto.baseUrl ?? 'wss://www.deribit.com/ws/api/v2',
        isTestnet: dto.isTestnet ?? false,
        isDefault: dto.isDefault ?? false,
      },
      select: SAFE_FIELDS,
    });

    return account;
  }

  async update(userId: string, id: string, dto: UpdateDeribitAccountDto) {
    const account = await this.prisma.deribitAccount.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException('Deribit account not found');

    const updated = await this.prisma.deribitAccount.update({
      where: { id },
      data: {
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.clientId !== undefined && { clientId: dto.clientId }),
        ...(dto.clientSecret !== undefined && { clientSecret: dto.clientSecret }),
        ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
        ...(dto.isTestnet !== undefined && { isTestnet: dto.isTestnet }),
      },
      select: SAFE_FIELDS,
    });

    this.deribitClientService.evictClient(userId);
    return updated;
  }

  async remove(userId: string, id: string) {
    const account = await this.prisma.deribitAccount.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException('Deribit account not found');

    const liveRunCount = await this.prisma.agentRun.count({
      where: { deribitAccountId: id, status: { in: ['ACTIVE', 'PAUSED'] } },
    });
    if (liveRunCount > 0) {
      throw new BadRequestException(
        'Cannot delete account while it has active or paused agent runs',
      );
    }

    this.deribitClientService.evictClient(userId);
    await this.prisma.deribitAccount.delete({ where: { id } });
  }

  async setDefault(userId: string, id: string) {
    const account = await this.prisma.deribitAccount.findFirst({ where: { id, userId } });
    if (!account) throw new NotFoundException('Deribit account not found');

    await this.prisma.$transaction([
      this.prisma.deribitAccount.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.deribitAccount.update({
        where: { id },
        data: { isDefault: true },
      }),
    ]);

    return this.prisma.deribitAccount.findUnique({ where: { id }, select: SAFE_FIELDS });
  }
}
