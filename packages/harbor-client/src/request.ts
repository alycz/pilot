export interface HarborRestDispatch {
  url: string;
  init: RequestInit;
}

/** Pure request builder shared by the live client and no-socket paired tests. */
export function createHarborRestDispatch(
  baseUrl: string,
  apiKey: string,
  name: string,
  args: unknown,
  signal: AbortSignal,
): HarborRestDispatch {
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/api/ops/${encodeURIComponent(name)}`,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal,
    },
  };
}
