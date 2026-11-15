export type FetchRequest = { url: string; headers?: Record<string, string>; maxBytes: number; timeoutMs: number };
export type FetchResponse = { status: number; headers: Headers; body: Uint8Array; finalUrl: string };
export type Fetcher = (request: FetchRequest) => Promise<FetchResponse>;

