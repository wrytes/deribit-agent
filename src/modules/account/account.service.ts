import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { Currency } from '@wrytlabs/deribit-api-client';

@Injectable()
export class AccountService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async getAccountSummary(userId: string, currency: string, extended?: boolean) {
    const client = await this.deribitClientService.getClient(userId);
    return client.account.getAccountSummary({ currency: currency as Currency, extended });
  }

  async getAccountSummaries(userId: string, extended?: boolean) {
    const client = await this.deribitClientService.getClient(userId);
    return client.account.getAccountSummaries({ extended });
  }

  async getPosition(userId: string, instrumentName: string) {
    const client = await this.deribitClientService.getClient(userId);
    return client.account.getPosition({ instrument_name: instrumentName });
  }

  async getTransactionLog(
    userId: string,
    currency: string,
    startTimestamp: number,
    endTimestamp: number,
    query?: Record<string, any>,
  ) {
    const client = await this.deribitClientService.getClient(userId);
    return client.account.getTransactionLog({
      currency: currency as Currency,
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
      ...query,
    });
  }

  async getPortfolioMargins(userId: string, currency: string, query?: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    return client.account.getPortfolioMargins({ currency: currency as Currency, ...query });
  }
}
