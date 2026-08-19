import type { Analysis } from '@caliper/core';
import type { AnalysisRepository } from '@caliper/service';
import { AnalysisModel, toAnalysis } from '../db/models.js';

/** Analyses are owned. A repository that cannot express that leaks other people's medical data. */
export class MongoAnalysisRepository implements AnalysisRepository {
  constructor(private readonly ownerId: string) {}

  async create(analysis: Analysis, idempotencyKey?: string): Promise<Analysis> {
    await AnalysisModel.create({
      _id: analysis.id,
      ownerId: this.ownerId,
      ...analysis,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return analysis;
  }

  async get(id: string): Promise<Analysis | null> {
    const doc = await AnalysisModel.findOne({ _id: id, ownerId: this.ownerId }).lean<never>();
    return doc ? toAnalysis(doc) : null;
  }

  async update(id: string, patch: Partial<Analysis>): Promise<Analysis> {
    const doc = await AnalysisModel.findOneAndUpdate(
      { _id: id, ownerId: this.ownerId },
      { $set: patch },
      { new: true },
    ).lean<never>();
    if (!doc) throw new Error(`Analysis ${id} not found`);
    return toAnalysis(doc);
  }

  async list({ limit = 20 }: { limit?: number } = {}): Promise<Analysis[]> {
    const docs = await AnalysisModel.find({ ownerId: this.ownerId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<never[]>();
    return docs.map(toAnalysis);
  }

  async findByIdempotencyKey(key: string): Promise<Analysis | null> {
    const doc = await AnalysisModel.findOne({ idempotencyKey: key, ownerId: this.ownerId }).lean<never>();
    return doc ? toAnalysis(doc) : null;
  }
}
