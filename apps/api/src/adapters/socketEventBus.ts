/**
 * Socket.IO event bus. One room per analysis, so a client only receives its own job's events.
 *
 * The handshake is authenticated: without it, knowing an analysis id would be enough to subscribe
 * to someone else's medical assessment as it streamed.
 */
import type { Server } from 'socket.io';
import { channelFor } from '@caliper/service';
import type { EventBus } from '@caliper/service';
import type { PipelineEvent } from '@caliper/core';
import { verifyToken } from '../auth.js';

export class SocketEventBus implements EventBus {
  constructor(private readonly io: Server) {}

  publish(event: PipelineEvent): void {
    this.io.to(channelFor(event.analysisId)).emit('analysis:event', event);
  }
}

export function attachSocketAuth(io: Server, jwtSecret: string): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthenticated'));
    try {
      const claims = verifyToken(token, jwtSecret);
      if (claims.typ === 'refresh') return next(new Error('wrong_token_type'));
      socket.data.principal = claims;
      next();
    } catch {
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('analysis:subscribe', (analysisId: string) => {
      if (typeof analysisId === 'string' && analysisId.length > 0) {
        void socket.join(channelFor(analysisId));
      }
    });
    socket.on('analysis:unsubscribe', (analysisId: string) => {
      if (typeof analysisId === 'string') void socket.leave(channelFor(analysisId));
    });
  });
}
