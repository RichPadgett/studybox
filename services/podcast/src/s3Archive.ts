import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Recording } from "@studybox/shared";

export interface S3ArchiveMetadata {
  archiveProvider: "s3";
  archiveBucket: string;
  archiveKey: string;
  archiveEndpoint: string;
  archiveSha256: string;
  archiveEtag?: string;
}

export class S3ZoomArchive {
  private client?: S3Client;
  private bucket?: string;
  private endpoint?: string;

  async upload(recording: Recording, filePath: string): Promise<S3ArchiveMetadata | undefined> {
    await this.configure();
    if (!this.client || !this.bucket || !this.endpoint) return undefined;
    const info = await stat(filePath);
    const sha256 = await sha256File(filePath);
    const key = `zoom/${new Date(recording.startedAt).toISOString().slice(0, 10)}/${recording.id}-${basename(filePath)}`;
    const put = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: info.size,
      ContentType: "video/mp4",
      Metadata: { sha256 }
    }));
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (head.ContentLength !== info.size || head.Metadata?.sha256 !== sha256) {
      throw new Error(`S3 archive verification failed for ${key}`);
    }
    return { archiveProvider: "s3", archiveBucket: this.bucket, archiveKey: key, archiveEndpoint: this.endpoint, archiveSha256: sha256, archiveEtag: put.ETag?.replaceAll('"', "") };
  }

  async signedUrl(bucket: string, key: string): Promise<string | undefined> {
    await this.configure();
    if (!this.client) return undefined;
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
  }

  private async configure(): Promise<void> {
    if (this.client) return;
    const accessKeyPath = process.env.STUDYBOX_S3_ACCESS_KEY_FILE ?? "/home/studybox/accesskey";
    const secretKeyPath = process.env.STUDYBOX_S3_SECRET_KEY_FILE ?? "/home/studybox/secretkey";
    const bucketPath = process.env.STUDYBOX_S3_BUCKET_FILE ?? "/home/studybox/bucket";
    try {
      const [accessKeyId, secretAccessKey, bucketFile] = await Promise.all([readFile(accessKeyPath, "utf8"), readFile(secretKeyPath, "utf8"), readFile(bucketPath, "utf8")]);
      const [bucket, endpointLine] = bucketFile.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!accessKeyId || !secretAccessKey || !bucket || !endpointLine) return;
      const endpoint = endpointLine.startsWith("http") ? endpointLine : `https://${endpointLine}`;
      this.client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() } });
      this.bucket = bucket;
      this.endpoint = endpoint;
    } catch {
      this.client = undefined;
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
