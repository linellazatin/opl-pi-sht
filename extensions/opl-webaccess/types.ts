export interface SearchResult {
  title: string;
  url: string;
}

export interface SearchQueryResult {
  query: string;
  answer: string;
  results: SearchResult[];
  error: string | null;
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface StoredData {
  id: string;
  type: "search" | "fetch";
  timestamp: number;
  queries?: SearchQueryResult[];
  urls?: ExtractedContent[];
  /** True when this is the session copy: body text was capped and lives in `file`. */
  truncated?: boolean;
  /** Path of the spilled full body in the disk cache, when one was written. */
  file?: string;
}
