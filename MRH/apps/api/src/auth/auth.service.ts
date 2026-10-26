import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { addDays } from 'date-fns';
import { PrismaService } from '../prisma/prisma.module';
import { AuthUser } from './auth.types';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private config: ConfigService) {}

  verifyAccessToken(token: string): AuthUser {
    try {
      const p = this.jwt.verify(token, { secret: this.config.getOrThrow('JWT_ACCESS_SECRET') });
      return { id: p.sub, role: p.role, permissions: p.permissions };
    } catch { throw new UnauthorizedException('Invalid or expired token'); }
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
    await this.prisma.refreshToken.delete({ where: { id: row.id } }); // rotate on every use
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
