import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthProxyService, IS_PUBLIC_KEY } from '@wrytes/wrytes-api';
import { PrismaService } from '../../core/database/prisma.service';

@Injectable()
export class WrytesAuthGuard implements CanActivate {
  constructor(
    private readonly authProxy: AuthProxyService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req   = ctx.switchToHttp().getRequest<Record<string, any>>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException();

    const identity = await this.authProxy.resolve(token);

    if (!identity.scopes.includes('DERIBIT') && !identity.scopes.includes('ADMIN')) {
      throw new ForbiddenException('DERIBIT scope required');
    }

    req['user'] = await this.prisma.user.upsert({
      where:  { wrytesUserId: identity.id },
      create: { wrytesUserId: identity.id, telegramHandle: identity.telegramHandle },
      update: { telegramHandle: identity.telegramHandle },
    });
    req['scopes'] = identity.scopes;

    return true;
  }

  private extractToken(req: Record<string, any>): string | null {
    const auth = req['headers']?.['authorization'] as string | undefined;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    const key = req['headers']?.['x-api-key'] as string | undefined;
    return key ?? null;
  }
}
