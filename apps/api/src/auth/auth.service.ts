import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { addDays } from 'date-fns';
import { AppError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.module';
import { AuthUser } from './auth.types';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type PreviewPayload = { resourceType: 'post' | 'page'; slug: string; sub: string };

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private config: ConfigService) {}

  verifyAccessToken(token: string): AuthUser {
    try {
      const p = this.jwt.verify(token, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
      if (p.aud === 'cms-preview' || p.tokenType === 'cms_preview' || p.type === 'preview') {
        throw new Error('Preview token is not an access token');
      }
      return { id: p.sub, role: p.role, permissions: p.permissions ?? [] };
    } catch { throw new UnauthorizedException('Invalid or expired token'); }
  }

  issuePreviewToken(payload: { resourceType: 'post' | 'page'; slug: string; actorId: string }) {
    const secret = this.config.get<string>('JWT_PREVIEW_SECRET');
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');
    if (!secret || secret === accessSecret) {
      throw new AppError(500, 'PREVIEW_SECRET_MISCONFIGURED', 'JWT_PREVIEW_SECRET must be set and distinct from JWT_ACCESS_SECRET');
    }
    return this.jwt.sign(
      { sub: payload.actorId, resourceType: payload.resourceType, slug: payload.slug, tokenType: 'cms_preview' },
      { secret, audience: 'cms-preview', expiresIn: '30m' },
    );
  }

  verifyPreviewToken(token: string): PreviewPayload {
    try {
      const secret = this.config.getOrThrow<string>('JWT_PREVIEW_SECRET');
      const decoded = this.jwt.verify(token, { secret, audience: 'cms-preview' });
      if (decoded.tokenType !== 'cms_preview' || !['post', 'page'].includes(decoded.resourceType) || typeof decoded.slug !== 'string' || typeof decoded.sub !== 'string') {
        throw new Error('Invalid preview token payload');
      }
      return decoded as PreviewPayload;
    } catch {
      throw new AppError(401, 'INVALID_PREVIEW_TOKEN', 'Preview token is invalid or expired');
    }
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() }, include: { role: true } });
    if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issue(user.id, user.role.name, user.role.permissions as string[]);
  }

  async refresh(refreshToken: string) {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: { include: { role: true } } },
    });
    if (!row || row.expiresAt < new Date() || row.user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid refresh token');
    await this.prisma.refreshToken.delete({ where: { id: row.id } });
    return this.issue(row.user.id, row.user.role.name, row.user.role.permissions as string[]);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash: sha256(refreshToken) } });
  }

  private async issue(userId: string, role: string, permissions: string[]) {
    const accessToken = this.jwt.sign({ sub: userId, role, permissions });
    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: sha256(refreshToken), expiresAt: addDays(new Date(), 30) },
    });
    return { accessToken, refreshToken, expiresIn: 900 };
  }
}
