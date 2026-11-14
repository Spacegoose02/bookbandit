/**
 * Minimal random-access zip reading for EPUB and CBZ. Only the central directory and
 * the entries we ask for are read, so a 500 MB comic doesn't get loaded into memory.
 */
import yauzl from "yauzl";

export interface ZipReader {
  /** Entry names in archive order. */
  names: string[];
  /** Reads one entry fully (throws if it's bigger than maxBytes). */
  read(name: string, maxBytes?: number): Promise<Buffer>;
  close(): void;
}

const DEFAULT_MAX = 25 * 1024 * 1024;

export function openZip(path: string): Promise<ZipReader> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Could not open zip"));
      const entries = new Map<string, yauzl.Entry>();
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.once("error", reject);
      zip.once("end", () => {
        resolve({
          names: [...entries.keys()],
          read: (name, maxBytes = DEFAULT_MAX) => readEntry(zip, entries, name, maxBytes),
          close: () => zip.close(),
        });
      });
      zip.readEntry();
    });
  });
}

function readEntry(
  zip: yauzl.ZipFile,
  entries: Map<string, yauzl.Entry>,
  name: string,
  maxBytes: number,
): Promise<Buffer> {
  const entry = entries.get(name) ?? findCaseInsensitive(entries, name);
  if (!entry) return Promise.reject(new Error(`No entry ${name}`));
  if (entry.uncompressedSize > maxBytes) return Promise.reject(new Error(`Entry ${name} too large`));
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("No stream"));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          stream.destroy(new Error(`Entry ${name} too large`));
          return;
        }
        chunks.push(c);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function findCaseInsensitive(entries: Map<string, yauzl.Entry>, name: string) {
  const lower = name.toLowerCase();
  for (const [k, v] of entries) if (k.toLowerCase() === lower) return v;
  return undefined;
}
