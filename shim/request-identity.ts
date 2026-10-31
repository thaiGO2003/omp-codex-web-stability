import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { record } from "./compatibility";

/**
 * Codex CLI compresses its Responses request bodies (`content-encoding: zstd`). The shim can only
 * inspect, rewrite and replay a request it can read, so decode every supported encoding here and
 * hand back plain JSON. Upstream accepts uncompressed JSON, so a decoded body is forwarded as-is
 * with its `content-encoding` header removed.
 */
export function decodeJsonRequestBody(bytes: Uint8Array, encoding: string | null | undefined): string | undefined {
  const encodings = (encoding ?? "")
    .toLowerCase()
    .split(",")
    .map(value => value.trim())
    .filter(value => value && value !== "identity")
    .reverse();
  let data: Uint8Array = bytes;
  for (const value of encodings) {
    try {
      if (value === "zstd") data = Bun.zstdDecompressSync(data);
      else if (value === "gzip" || value === "x-gzip") data = gunzipSync(data);
      else if (value === "deflate") data = inflateSync(data);
      else if (value === "br") data = brotliDecompressSync(data);
      else return undefined;
    } catch {
      return undefined;
    }
  }
  const text = new TextDecoder().decode(data);
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  return text;
}

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return record(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Native turn ownership travels in the body for OMP and in a header for Codex CLI. */
export function readTurnMetadata(
  parsed: Record<string, unknown> | undefined,
  headerMetadata?: string,
): Record<string, unknown> | undefined {
  const client = record(parsed?.client_metadata);
  return parseMetadata(client?.["x-codex-turn-metadata"]) ?? parseMetadata(headerMetadata);
}

/**
 * Codex CLI keeps `x-codex-turn-metadata` in a header only. Recovery rebinding edits the body copy,
 * so mirror the header into the request when the body has none. The value is identical to the one
 * the native client already sent, so this adds no authority.
 */
export function attachTurnMetadata(
  parsed: Record<string, unknown>,
  headerMetadata?: string,
): Record<string, unknown> | undefined {
  const client = record(parsed.client_metadata);
  if (!client) return parseMetadata(headerMetadata);
  const existing = parseMetadata(client["x-codex-turn-metadata"]);
  if (existing) return existing;
  const metadata = parseMetadata(headerMetadata);
  if (!metadata) return undefined;
  client["x-codex-turn-metadata"] = JSON.stringify(metadata);
  return metadata;
}

/** Request identity used for per-thread serialization, logging and scoped native interruption. */
export function turnIdentity(metadata: Record<string, unknown> | undefined): {
  threadId?: string;
  turnId?: string;
} {
  const threadId = typeof metadata?.thread_id === "string" && metadata.thread_id ? metadata.thread_id : undefined;
  const turnId = typeof metadata?.turn_id === "string" && metadata.turn_id ? metadata.turn_id : undefined;
  return { threadId, turnId };
}
