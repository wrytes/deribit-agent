import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { Currency } from '@wrytlabs/deribit-api-client';

@Injectable()
export class WalletService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async getDeposits(userId: string, currency: string, query?: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.getDeposits({ currency: currency as Currency, ...query });
    return this.deribitClientService.unwrap(res);
  }

  async getWithdrawals(userId: string, currency: string, query?: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.getWithdrawals({ currency: currency as Currency, ...query });
    return this.deribitClientService.unwrap(res);
  }

  async getTransfers(userId: string, currency: string, query?: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.getTransfers({ currency: currency as Currency, ...query });
    return this.deribitClientService.unwrap(res);
  }

  async getCurrentDepositAddress(userId: string, currency: string): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.getCurrentDepositaddress({ currency: currency as Currency });
    return this.deribitClientService.unwrap(res);
  }

  async createDepositAddress(userId: string, currency: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.createDepositaddress({ currency: currency as Currency });
    return this.deribitClientService.unwrap(res);
  }

  async withdraw(userId: string, body: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.withdraw(body as any);
    return this.deribitClientService.unwrap(res);
  }

  async cancelTransferById(userId: string, id: number, currency: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.cancelTransferById({ id, currency: currency as Currency });
    return this.deribitClientService.unwrap(res);
  }

  async cancelWithdrawal(userId: string, id: number, currency: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.wallet.cancelWithdrawal({ currency: currency as Currency, id });
    return this.deribitClientService.unwrap(res);
  }
}
