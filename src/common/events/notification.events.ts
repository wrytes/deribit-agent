export class OrderFilledEvent {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
    public readonly instrumentName: string,
    public readonly direction: 'buy' | 'sell',
    public readonly amount: number,
    public readonly price: number,
  ) {}
}

export class OrderCancelledEvent {
  constructor(
    public readonly userId: string,
    public readonly orderId: string,
    public readonly instrumentName: string,
  ) {}
}

export class TradeErrorEvent {
  constructor(
    public readonly userId: string,
    public readonly error: string,
    public readonly context?: string,
  ) {}
}
