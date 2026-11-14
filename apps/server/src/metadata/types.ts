/** Metadata read from a book file or fetched from an online provider. All fields optional. */
export interface BookMetadata {
  title?: string;
  subtitle?: string;
  authors?: string[];
  description?: string;
  language?: string;
  publisher?: string;
  publishedYear?: number;
  isbn13?: string;
  pageCount?: number;
  series?: string;
  seriesPosition?: number;
  /** Genres / subjects / categories, as the source wrote them. */
  subjects?: string[];
  /** Content warnings (Hardcover), e.g. "Sexual content". Used only for rating. */
  contentWarnings?: string[];
  /** ComicInfo.xml AgeRating, e.g. "Everyone 10+", "Mature 17+". */
  ageRating?: string;
}

export interface Cover {
  data: Buffer;
  /** e.g. image/jpeg */
  mime: string;
}

export interface FileMetadata extends BookMetadata {
  cover?: Cover;
}

/** A match from an online provider. */
export interface ProviderMatch extends BookMetadata {
  provider: "openlibrary" | "google" | "hardcover" | "isbndb";
  /** The provider's own id for the work/volume/book. */
  providerId: string;
  coverUrl?: string;
  /** Google Books maturityRating: "MATURE" or "NOT_MATURE". */
  maturityRating?: "MATURE" | "NOT_MATURE";
}
