import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { Currency } from '@wrytlabs/deribit-api-client';

@Injectable()
export class WalletService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async getDeposits(userId: string, currency: string, query?: Record<string, any>): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.getDeposits({ currency: currency as Currency, ...query });
  }

  async getWithdrawals(userId: string, currency: string, query?: Record<string, any>): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.getWithdrawals({ currency: currency as Currency, ...query });
  }

  async getTransfers(userId: string, currency: string, query?: Record<string, any>): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.getTransfers({ currency: currency as Currency, ...query });
  }

  async getCurrentDepositAddress(userId: string, currency: string): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.getCurrentDepositaddress({ currency: currency as Currency });
  }

  async createDepositAddress(userId: string, currency: string): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.createDepositaddress({ currency: currency as Currency });
  }

  async withdraw(userId: string, body: Record<string, any>): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.withdraw(body as any);
  }

  async cancelTransferById(userId: string, id: number, currency: string): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.cancelTransferById({ id, currency: currency as Currency });
  }

  async cancelWithdrawal(userId: string, id: number, currency: string): Promise<any> {
    const client = await this.deribitClientService.getClient(userId);
    return client.wallet.cancelWithdrawal({ currency: currency as Currency, id });
  }
}
