/** JWT auth with three roles. Deliberately boring — the interesting parts of this system are elsewhere. */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';

export const ROLES = ['patient', 'clinician', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  userId: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export const CredentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(10).max(200),
  role: z.enum(ROLES).optional(),
});

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

export function signAccessToken(principal: Principal, secret: string): string {
  return jwt.sign(principal, secret, { expiresIn: '30m' });
}

export function signRefreshToken(principal: Principal, secret: string): string {
  return jwt.sign({ ...principal, typ: 'refresh' }, secret, { expiresIn: '30d' });
}

export function verifyToken(token: string, secret: string): Principal & { typ?: string } {
  return jwt.verify(token, secret) as Principal & { typ?: string };
}

export function requireAuth(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'Bearer token required' } });
      return;
    }
    try {
      const claims = verifyToken(header.slice(7), secret);
      // A refresh token is not an access token. Accepting one here would turn a 30-day credential
      // into a 30-day API session.
      if (claims.typ === 'refresh') {
        res.status(401).json({ error: { code: 'wrong_token_type', message: 'Access token required' } });
        return;
      }
      req.principal = { userId: claims.userId, email: claims.email, role: claims.role };
      next();
    } catch {
      res.status(401).json({ error: { code: 'invalid_token', message: 'Token is invalid or expired' } });
    }
  };
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.principal || !allowed.includes(req.principal.role)) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Insufficient role' } });
      return;
    }
    next();
  };
}
