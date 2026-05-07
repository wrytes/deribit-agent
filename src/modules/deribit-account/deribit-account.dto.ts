import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDeribitAccountDto {
  @ApiPropertyOptional({ description: 'Friendly label for this account', default: 'default' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ description: 'Deribit Client ID' })
  @IsString()
  clientId: string;

  @ApiProperty({ description: 'Deribit Client Secret' })
  @IsString()
  clientSecret: string;

  @ApiPropertyOptional({
    description: 'WebSocket base URL',
    default: 'wss://www.deribit.com/ws/api/v2',
  })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Use testnet', default: false })
  @IsOptional()
  @IsBoolean()
  isTestnet?: boolean;

  @ApiPropertyOptional({ description: 'Set as default account for live runs', default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateDeribitAccountDto {
  @ApiPropertyOptional({ description: 'Friendly label for this account' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ description: 'Deribit Client ID' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Deribit Client Secret' })
  @IsOptional()
  @IsString()
  clientSecret?: string;

  @ApiPropertyOptional({ description: 'WebSocket base URL' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Use testnet' })
  @IsOptional()
  @IsBoolean()
  isTestnet?: boolean;
}
