import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

export interface StorageOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey?: string;
  readonly secretKey?: string;
  /** Credentials read when the first request needs them (a process that may never touch storage still boots). */
  readonly credentials?: () => Promise<{ accessKey: string; secretKey: string }>;
  /** SeaweedFS and most on-prem S3 stores need path-style URLs. */
  readonly forcePathStyle?: boolean;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Buffer | Uint8Array | string | Readable;
  readonly contentType: string;
  readonly metadata?: Record<string, string>;
}

export interface StoredObject {
  readonly key: string;
  readonly bucket: string;
  readonly etag?: string;
}

/**
 * Thin, provider-neutral façade over the S3 API. Domain code stores the returned key in a
 * `*_asset_id`/`storage_key` column; it never builds URLs itself.
 */
export class StorageService {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor(options: StorageOptions, client?: S3Client) {
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: options.credentials
        ? async () => {
            const c = await options.credentials!();
            return { accessKeyId: c.accessKey, secretAccessKey: c.secretKey };
          }
        : { accessKeyId: options.accessKey ?? '', secretAccessKey: options.secretKey ?? '' },
    };
    this.client = client ?? new S3Client(config);
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    return { key: input.key, bucket: this.bucket, ...(res.ETag ? { etag: res.ETag } : {}) };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return Buffer.from(bytes ?? new Uint8Array());
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Time-limited URL for direct download by a browser/app; default 15 minutes. */
  getSignedDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  /** Time-limited URL for direct upload (guest photos, inspection photos); default 15 minutes. */
  getSignedUploadUrl(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}
