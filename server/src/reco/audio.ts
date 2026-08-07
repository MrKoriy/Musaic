import { sidecarGet } from "../providers/sidecar.js";

export async function fetchAudioEmbedding(filePath: string): Promise<number[]> {
  const response = await sidecarGet<{ vector?: number[]; dimensions?: number }>(
    `/audio/embedding?path=${encodeURIComponent(filePath)}`,
    {},
    60_000,
  );
  const vector = (response.vector ?? []).map(Number).filter(Number.isFinite);
  if (vector.length === 0) throw new Error("sidecar returned an empty audio embedding");
  return vector.slice(0, Number(response.dimensions ?? vector.length));
}

export function encodeEmbedding(vector: number[]): Uint8Array {
  const encoded = new Float32Array(vector);
  return new Uint8Array(encoded.buffer);
}

export function decodeEmbedding(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    const bytes = value.byteLength - (value.byteLength % 4);
    return Array.from(new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + bytes)));
  }
  if (value instanceof ArrayBuffer) return Array.from(new Float32Array(value));
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  return [];
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}
