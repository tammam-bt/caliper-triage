/**
 * Media in GridFS.
 *
 * Chosen because it keeps the prototype to a single dependency: `docker compose up` gives a working
 * system with no object-storage account. It is the wrong answer at scale — see
 * `docs/ARCHITECTURE.md`, where uploads go straight to S3 via presigned URLs and never transit the
 * API process at all.
 *
 * `GridFSBucket` is taken from `mongoose.mongo` rather than importing `mongodb` directly: the two
 * resolve to different copies of the driver in this workspace, and mixing them is a type error at
 * best and two connection pools at worst.
 */
import mongoose from 'mongoose';
import { MediaRefSchema, type MediaRef } from '@caliper/core';
import type { MediaStore, StoredMedia } from '@caliper/service';

export class GridFsMediaStore implements MediaStore {
  private get bucket(): InstanceType<typeof mongoose.mongo.GridFSBucket> {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Mongo is not connected');
    return new mongoose.mongo.GridFSBucket(db, { bucketName: 'media' });
  }

  /** Keyed by filename rather than a custom `_id`, which keeps ObjectId out of the domain. */
  async put({ ref, bytes }: StoredMedia): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket.openUploadStream(ref.id, { metadata: ref });
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      stream.end(Buffer.from(bytes));
    });
  }

  async get(id: string): Promise<StoredMedia | null> {
    const [file] = await this.bucket.find({ filename: id }).limit(1).toArray();
    if (!file) return null;

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket.openDownloadStream(file._id);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });

    return {
      ref: MediaRefSchema.parse(file.metadata as MediaRef),
      bytes: new Uint8Array(Buffer.concat(chunks)),
    };
  }

  async delete(id: string): Promise<void> {
    const [file] = await this.bucket.find({ filename: id }).limit(1).toArray();
    if (file) await this.bucket.delete(file._id).catch(() => undefined);
  }
}
