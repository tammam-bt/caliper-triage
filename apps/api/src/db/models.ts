/**
 * Mongoose models.
 *
 * The stored shape deliberately mirrors the Zod schemas in `@caliper/core` rather than inventing a
 * parallel one; `toAnalysis` is the single place the two representations meet, so a drift shows up
 * as a type error here instead of as a malformed API response.
 */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { AnalysisSchema, type Analysis } from '@caliper/core';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['patient', 'clinician', 'admin'], default: 'patient', required: true },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);

const analysisSchema = new Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    status: { type: String, required: true, index: true },
    stage: { type: String, required: true },
    progress: { type: Number, required: true },
    intake: { type: Schema.Types.Mixed, required: true },
    media: { type: Schema.Types.Mixed, required: true },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    // Unique but sparse: most submissions carry no key, and the ones that do must not collide.
    idempotencyKey: { type: String, index: true, unique: true, sparse: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { _id: false, versionKey: false },
);

export type AnalysisDoc = InferSchemaType<typeof analysisSchema> & { _id: string };
export const AnalysisModel = model<AnalysisDoc>('Analysis', analysisSchema);

/** Validates on the way out, so a hand-edited document cannot become a malformed API response. */
export function toAnalysis(doc: AnalysisDoc): Analysis {
  return AnalysisSchema.parse({
    id: doc._id,
    status: doc.status,
    stage: doc.stage,
    progress: doc.progress,
    intake: doc.intake,
    media: doc.media,
    ...(doc.result ? { result: doc.result } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}
