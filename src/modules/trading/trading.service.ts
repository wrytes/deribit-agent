import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { TradingBuyDto, TradingSellDto } from './trading.dto';

@Injectable()
export class TradingService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async buy(userId: string, dto: TradingBuyDto) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.buy(dto);
    return this.deribitClientService.unwrap(res);
  }

  async sell(userId: string, dto: TradingSellDto) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.sell(dto);
    return this.deribitClientService.unwrap(res);
  }

  async cancel(userId: string, orderId: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.cancel({ order_id: orderId });
    return this.deribitClientService.unwrap(res);
  }

  async getOpenOrdersByCurrency(userId: string, currency: string, kind?: string, type?: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.getOpenOrdersByCurrency({ currency, kind, type });
    return this.deribitClientService.unwrap(res);
  }

  async getOpenOrdersByInstrument(userId: string, instrumentName: string, type?: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.getOpenOrdersByInstrument({ instrument_name: instrumentName, type });
    return this.deribitClientService.unwrap(res);
  }

  async getOrderState(userId: string, orderId: string) {
    const client = await this.deribitClientService.getClient(userId);
    const res = await client.trading.getOrderState({ order_id: orderId });
    return this.deribitClientService.unwrap(res);
  }
}
