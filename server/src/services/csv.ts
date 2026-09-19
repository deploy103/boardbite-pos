/**
 * CSV 직렬화 유틸.
 *
 * 1) RFC 4180 이스케이프: 쉼표/줄바꿈/따옴표가 포함된 값은 따옴표로 감싸고 내부 따옴표를 중복한다.
 * 2) Formula injection 방어(요구사항2.md §5.3): displayName / 메뉴명 / 사유 / metadata처럼
 *    사용자·관리자가 자유롭게 입력한 값이 `=`, `+`, `-`, `@`, TAB, CR로 시작하면 Excel·LibreOffice·
 *    Google Sheets가 이를 수식으로 실행할 수 있다. OWASP 권고대로 작은따옴표를 앞에 붙여
 *    항상 문자열로 읽히게 만든다.
 */

const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** 수식으로 해석될 수 있는 값을 무해한 텍스트로 만든다. 숫자 타입은 그대로 둔다. */
export function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGERS.has(value[0]) ? `'${value}` : value;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return "";
    // number는 사용자 입력이 아니므로 수식 중화 대상이 아니다(음수 -1000이 '-1000이 되면 안 됨).
    const str = typeof value === "number" ? String(value) : neutralizeFormula(String(value));
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(row.map(escape).join(","));
  }
  // 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 앞에 붙인다.
  return "﻿" + lines.join("\r\n");
}
