const JSON_HEADERS = { "Content-Type": "application/json", "X-BoardBite-Client": "1" };

/**
 * 서버가 내려주는 오류. `code`는 화면이 분기해야 하는 상황을 구분하기 위한 기계용 값이고
 * (`STEP_UP_REQUIRED`, `PASSWORD_RESET_REQUIRED`, `CLOSE_BLOCKED` …), `message`는 사람이 읽는 문구다.
 * `body`에는 blockers 같은 부가 정보가 그대로 담긴다.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 네트워크가 끊겨 요청 자체가 서버에 닿지 못한 경우. 재시도해도 안전한지 판단이 달라진다. */
export class NetworkError extends Error {
  constructor(message = "서버에 연결할 수 없어요.") {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 연결 상태 공유 (요구사항2.md §9.3)
//
// 화면마다 따로 판단하지 않고, 모든 API 호출 결과를 여기로 모아 한 곳에서 상태를 만든다.
// REST가 연속으로 실패하면 "연결 불안정"으로 보고, 한 번이라도 성공하면 즉시 회복으로 본다.
// ---------------------------------------------------------------------------

export type ConnectionState = "online" | "unstable" | "offline";

const CONSECUTIVE_FAILURES_FOR_UNSTABLE = 2;

let consecutiveFailures = 0;
let socketConnected = true;
const listeners = new Set<(state: ConnectionState) => void>();

function currentState(): ConnectionState {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (consecutiveFailures >= CONSECUTIVE_FAILURES_FOR_UNSTABLE) return "offline";
  if (consecutiveFailures > 0 || !socketConnected) return "unstable";
  return "online";
}

function emit() {
  const state = currentState();
  for (const listener of listeners) listener(state);
}

export function subscribeConnection(listener: (state: ConnectionState) => void): () => void {
  listeners.add(listener);
  listener(currentState());
  return () => listeners.delete(listener);
}

/** 소켓 연결/끊김을 연결 상태에 반영한다(useStaffSocket / CustomerApp에서 호출). */
export function reportSocketState(connected: boolean) {
  socketConnected = connected;
  emit();
}

function reportRequestResult(ok: boolean) {
  const before = currentState();
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
  if (currentState() !== before) emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", emit);
  window.addEventListener("offline", emit);
}

// ---------------------------------------------------------------------------

async function handle(res: Response) {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(
      body?.error ?? "요청 처리 중 오류가 발생했습니다.",
      res.status,
      body?.code,
      body ?? undefined,
    );
  }
  return body;
}

async function send(path: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init });
  } catch {
    // fetch 자체가 실패 = 요청이 서버에 닿지 못했다. 서버 오류(5xx)와 구분해서 알려준다.
    reportRequestResult(false);
    throw new NetworkError();
  }
  // 서버가 응답했다면 연결 자체는 살아있다 — 4xx/5xx는 연결 문제로 치지 않는다.
  reportRequestResult(true);
  return handle(res);
}

export const api = {
  get: (path: string) => send(path, { method: "GET" }),
  post: (path: string, data?: unknown) =>
    send(path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  patch: (path: string, data?: unknown) =>
    send(path, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  /** 논리 삭제 계열 API(메뉴/카테고리/옵션). 서버는 행을 지우지 않고 deletedAt만 채운다. */
  del: (path: string) => send(path, { method: "DELETE", headers: JSON_HEADERS }),
};

/** 화면에 그대로 띄워도 안전한 문구로 바꾼다 — 내부 용어가 손님에게 새어 나가지 않게 한다(§10.3). */
export function errorMessage(err: unknown, fallback = "요청 처리 중 오류가 발생했어요."): string {
  if (err instanceof NetworkError) return "서버에 연결할 수 없어요. 네트워크를 확인한 뒤 다시 시도해 주세요.";
  if (err instanceof ApiError) return err.message;
  return fallback;
}
