const JSON_HEADERS = { "Content-Type": "application/json", "X-BoardBite-Client": "1" };

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function handle(res: Response) {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(body?.error ?? "요청 처리 중 오류가 발생했습니다.", res.status);
  }
  return body;
}

export const api = {
  get: (path: string) => fetch(path, { credentials: "include" }).then(handle),
  post: (path: string, data?: unknown) =>
    fetch(path, {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }).then(handle),
  patch: (path: string, data?: unknown) =>
    fetch(path, {
      method: "PATCH",
      credentials: "include",
      headers: JSON_HEADERS,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }).then(handle),
};
