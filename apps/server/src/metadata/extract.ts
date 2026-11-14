/** Reads whatever metadata a book file carries, falling back to its path for the gaps. */
import type { BookFormat } from "../library/formats.js";
import type { FileMetadata } from "./types.js";
import { readEpub } from "./epub.js";
import { readCbz } from "./cbz.js";
import { readPdf } from "./pdf.js";
import { metadataFromPath } from "./filename.js";

export interface ExtractInput {
  absPath: string;
  relPath: string;
  format: BookFormat;
  sizeBytes: number;
  /** Folder names that are not author names (rating folders, "inbox", ...). */
  ignoreDirs?: ReadonlySet<string>;
}

export interface ExtractResult {
  metadata: FileMetadata;
  /** Set when the file couldn't be parsed; the path-based guess is used instead. */
  error?: string;
}

export async function extractMetadata(input: ExtractInput): Promise<ExtractResult> {
  const fromPath = metadataFromPath(input.relPath, input.ignoreDirs);
  let fromFile: FileMetadata = {};
  let error: string | undefined;
  try {
    switch (input.format) {
      case "epub":
      case "kepub":
        fromFile = await readEpub(input.absPath);
        break;
      case "cbz":
        fromFile = await readCbz(input.absPath);
        break;
      case "pdf":
        fromFile = await readPdf(input.absPath, input.sizeBytes);
        break;
      default:
        // mobi/azw3/fb2/cbr/txt: path only for now.
        break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { metadata: mergeMetadata(fromFile, fromPath), error };
}

/** Fill gaps in `primary` from `fallback`. Arrays are taken whole from whichever has them first. */
export function mergeMetadata<T extends object>(primary: T, fallback: Partial<T>): T {
  const out = { ...primary } as Record<string, unknown>;
  for (const [k, v] of Object.entries(fallback)) {
    const cur = out[k];
    const empty = cur == null || cur === "" || (Array.isArray(cur) && cur.length === 0);
    if (empty && v != null) out[k] = v;
  }
  return out as T;
}
