import { useEffect, useState } from "react";
import { subscribeConnection, type ConnectionState } from "./api.js";

/** 모든 화면 상단의 연결 상태 배너가 쓰는 훅(요구사항2.md §9.3). */
export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>("online");
  useEffect(() => subscribeConnection(setState), []);
  return state;
}
