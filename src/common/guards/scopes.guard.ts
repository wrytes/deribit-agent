import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from '@wrytes/wrytes-api';

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const scopes: string[] = ctx.switchToHttp().getRequest()['scopes'] ?? [];
    if (scopes.includes('ADMIN')) return true;
    return required.every((s) => scopes.includes(s));
  }
}
