/**
 * The single definition of every shape that crosses a boundary.
 *
 * Server, browser and mobile all import from here, so the API contract cannot drift between
 * them. Types are *derived* from the schemas (`z.infer`) and never hand-written alongside, which
 * makes it impossible for a validator and its type to disagree.
 */
import { z } from 'zod';

export const CONDITION_IDS = [
  'melanoma',
  'basal_cell_carcinoma',
  'squamous_cell_carcinoma',
  'benign_nevus',
  'seborrheic_keratosis',
  'eczema_dermatitis',
  'psoriasis',
  'cellulitis',
  'insufficient_evidence',
] as const;

export const ConditionIdSchema = z.enum(CONDITION_IDS);
export type ConditionId = z.infer<typeof ConditionIdSchema>;

/** Triage vocabulary, borrowed from real acuity scales rather than invented. */
export const AcuitySchema = z.enum(['urgent', 'prompt', 'routine', 'indeterminate']);
export type Acuity = z.infer<typeof AcuitySchema>;

export const MediaKindSchema = z.enum(['image', 'video']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export const IntakeSchema = z.object({
  /** Free-text description. Parsed for symptom tokens, including negations. */
  symptomsText: z.string().max(2000).default(''),
  /** Structured symptom chips the user ticked. */
  symptomIds: z.array(z.string().min(1).max(64)).max(40).default([]),
  /** Optional. The user's own guess never overrides the model; it is one evidence source. */
  suspectedConditionId: ConditionIdSchema.optional(),
  bodySite: z.string().max(80).optional(),
  durationDays: z.number().int().min(0).max(36500).optional(),
  /** "Has it changed recently?" — the single strongest historical red flag in skin triage. */
  evolving: z.boolean().optional(),
});
export type Intake = z.infer<typeof IntakeSchema>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MediaRefSchema = z.object({
  id: z.string().min(1),
  kind: MediaKindSchema,
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Video only. */
  durationMs: z.number().nonnegative().optional(),
  /** Video only: how many frames were sampled for inference. */
  sampledFrames: z.number().int().positive().optional(),
  /** Physical scale, when a reference object or EXIF gives us one. Enables mm measurements. */
  pixelsPerMm: z.number().positive().optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export const QualityIssueSchema = z.object({
  code: z.enum(['blur', 'underexposed', 'overexposed', 'too_small', 'no_subject', 'low_contrast']),
  measured: z.number(),
  threshold: z.number(),
  /** Written for the person holding the camera: what is wrong and what to do about it. */
  message: z.string(),
});
export type QualityIssue = z.infer<typeof QualityIssueSchema>;

export const QualityReportSchema = z.object({
  usable: z.boolean(),
  issues: z.array(QualityIssueSchema),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

export const PointSchema = z.tuple([z.number(), z.number()]);

/**
 * The classical ABCD-derived descriptor set, plus the acquisition-quality measures.
 * Every field is a number the UI can display next to its name — nothing opaque.
 */
export const ImageFeaturesSchema = z.object({
  /** 0 = perfectly symmetric about both principal axes; grows with asymmetry. */
  asymmetry: z.number(),
  /** Reciprocal circularity, perimeter^2 / (4*pi*area). 1.0 = perfect circle. */
  borderIrregularity: z.number(),
  /** Effective number of distinct colour clusters inside the lesion mask. */
  colourHeterogeneity: z.number(),
  /** Major-axis length of the mask, in pixels. */
  diameterPx: z.number(),
  /** Present only when `pixelsPerMm` is known. */
  diameterMm: z.number().optional(),
  /** Shannon entropy of the intra-mask luminance histogram, in bits. */
  textureEntropy: z.number(),
  /** Variance of the Laplacian. Higher is sharper. */
  blurScore: z.number(),
  /** 0 = badly exposed, 1 = well exposed. */
  exposureScore: z.number(),
  /** Mask area as a fraction of the frame. Sanity-checks the segmentation. */
  maskAreaRatio: z.number(),
  /** Traced outline of the lesion, in source-image pixel coordinates. Drawn by the viewport. */
  contour: z.array(PointSchema),
  /** Fraction of intra-lesion pixels well above the local mean — scale, crust, specular sheen. */
  brightSpeckleRatio: z.number(),
  /** Mean RGB inside the mask, for the colour readout. */
  meanColour: z.tuple([z.number(), z.number(), z.number()]),
});
export type ImageFeatures = z.infer<typeof ImageFeaturesSchema>;

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export const EvidenceItemSchema = z.object({
  source: z.enum(['image', 'symptom', 'prior', 'model', 'history']),
  /** Short human label, e.g. "Border irregularity". */
  label: z.string(),
  /** The measured value rendered for display, e.g. "2.41 (high)". */
  detail: z.string(),
  /** Signed log-odds contribution. Positive supports the condition. */
  contribution: z.number(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const CandidateSchema = z.object({
  conditionId: ConditionIdSchema,
  displayName: z.string(),
  probability: z.number().min(0).max(1),
  logOdds: z.number(),
  acuity: AcuitySchema,
  /** Sorted by |contribution| descending. This is what makes the readout defensible. */
  evidence: z.array(EvidenceItemSchema),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const InferenceResultSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  candidates: z.array(CandidateSchema),
  /** True when the calibration layer refused to commit. See `fusion.ts`. */
  abstained: z.boolean(),
  abstainReason: z.string().optional(),
  /** Calibrated top-1 probability. Not the raw softmax peak. */
  confidence: z.number().min(0).max(1),
  acuity: AcuitySchema,
  quality: QualityReportSchema,
  features: ImageFeaturesSchema.optional(),
  /** Per-frame features for video, in sample order. */
  frameFeatures: z.array(ImageFeaturesSchema).optional(),
  computeMs: z.number().nonnegative(),
});
export type InferenceResult = z.infer<typeof InferenceResultSchema>;

// ---------------------------------------------------------------------------
// Analysis lifecycle
// ---------------------------------------------------------------------------

export const STAGES = [
  'received',
  'preprocess',
  'features',
  'inference',
  'fusion',
  'complete',
] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const AnalysisStatusSchema = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

export const AnalysisSchema = z.object({
  id: z.string().min(1),
  status: AnalysisStatusSchema,
  stage: StageSchema,
  progress: z.number().min(0).max(1),
  intake: IntakeSchema,
  media: MediaRefSchema,
  result: InferenceResultSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** Streamed over Socket.IO in `apps/api`, and over an EventTarget in the browser demo. */
export const PipelineEventSchema = z.object({
  analysisId: z.string(),
  status: AnalysisStatusSchema,
  stage: StageSchema,
  progress: z.number().min(0).max(1),
  at: z.string(),
  message: z.string().optional(),
  result: InferenceResultSchema.optional(),
  error: z.string().optional(),
});
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

// ---------------------------------------------------------------------------
// Transport envelopes
// ---------------------------------------------------------------------------

/**
 * What a client may say about its upload. Deliberately *not* `MediaRefSchema`: the storage id is
 * assigned by the server. A client-chosen media id is a way to overwrite, or read, someone else's
 * stored media.
 */
export const MediaUploadSchema = MediaRefSchema.omit({ id: true });
export type MediaUpload = z.infer<typeof MediaUploadSchema>;

export const SubmitAnalysisRequestSchema = z.object({
  intake: IntakeSchema,
  media: MediaUploadSchema,
  /** Client-generated. Re-submitting the same key returns the original analysis. */
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export type SubmitAnalysisRequest = z.infer<typeof SubmitAnalysisRequestSchema>;

export const SubmitAnalysisResponseSchema = z.object({
  analysisId: z.string(),
  status: AnalysisStatusSchema,
  /** Where to subscribe for live stage events. */
  channel: z.string(),
});
export type SubmitAnalysisResponse = z.infer<typeof SubmitAnalysisResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
