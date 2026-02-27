import { Injectable } from '@nestjs/common';
import { DeribitClientService } from '../../integrations/deribit/deribit.client.service';
import { TradingBuyDto, TradingSellDto } from './trading.dto';

@Injectable()
export class TradingService {
  constructor(private readonly deribitClientService: DeribitClientService) {}

  async buy(userId: string, dto: TradingBuyDto) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.buy(dto);
  }

  async sell(userId: string, dto: TradingSellDto) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.sell(dto);
  }

  async cancel(userId: string, orderId: string) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.cancel({ order_id: orderId });
  }

  async getOpenOrdersByCurrency(userId: string, currency: string, kind?: string, type?: string) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.getOpenOrdersByCurrency({ currency, kind, type });
  }

  async getOpenOrdersByInstrument(userId: string, instrumentName: string, type?: string) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.getOpenOrdersByInstrument({ instrument_name: instrumentName, type });
  }

  async getOrderState(userId: string, orderId: string) {
    const client = await this.deribitClientService.getClient(userId);
    return client.trading.getOrderState({ order_id: orderId });
  }
}
