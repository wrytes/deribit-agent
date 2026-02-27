import { IsString, IsOptional, IsBoolean, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertDeribitAccountDto {
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
}
