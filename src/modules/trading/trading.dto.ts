import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderType, TimeInForce } from '@wrytlabs/deribit-api-client';

export class TradingBuyDto {
  @ApiProperty({ description: 'Instrument name, e.g. BTC-PERPETUAL' })
  @IsString()
  instrument_name: string;

  @ApiProperty({ description: 'Amount to buy' })
  @IsNumber()
  amount: number;

  @ApiProperty({ enum: OrderType, description: 'Order type' })
  @IsEnum(OrderType)
  type: OrderType;

  @ApiPropertyOptional({ description: 'Limit price (required for limit orders)' })
  @IsOptional()
  @IsNumber()
  price?: number;

  @ApiPropertyOptional({ description: 'User-defined label' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ enum: TimeInForce })
  @IsOptional()
  @IsEnum(TimeInForce)
  time_in_force?: TimeInForce;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reduce_only?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  post_only?: boolean;
}

export class TradingSellDto extends TradingBuyDto {}
