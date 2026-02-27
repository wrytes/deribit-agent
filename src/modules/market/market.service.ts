import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { MarketGetDeliveryPricesNames } from '@wrytlabs/deribit-api-client';

@Injectable()
export class MarketService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async getBookSummaryByCurrency(userId: string, currency: string, kind?: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.market.getBookSummaryByCurrency({ currency: currency as any, kind: kind as any });
    return this.deribitClientService.unwrap(res);
  }

  async getBookSummaryByInstrument(userId: string, instrumentName: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.market.getBookSummaryByInstrument({ instrument_name: instrumentName });
    return this.deribitClientService.unwrap(res);
  }

  async getCurrencies(userId: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.market.getCurrencies({});
    return this.deribitClientService.unwrap(res);
  }

  async getDeliveryPrices(userId: string, indexName: string, query?: Record<string, any>) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.market.getDeliveryPrices({
      index_name: indexName as MarketGetDeliveryPricesNames,
      ...query,
    });
    return this.deribitClientService.unwrap(res);
  }
}
