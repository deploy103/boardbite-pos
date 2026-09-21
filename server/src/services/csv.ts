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

/**
 * 스프레드시트가 "텍스트"로 읽도록 강제한다(앞자리 0 보존).
 *
 * 따옴표로 감싸는 것만으로는 부족하다 — CSV의 따옴표는 구조적 이스케이프일 뿐 자료형 힌트가 아니라서
 * Excel은 "001"을 여전히 숫자 1로 바꾼다. 앞에 탭(0x09)을 두면 숫자로 파싱되지 않아 텍스트로 남고,
 * OWASP가 권고하는 "따옴표 안 탭 접두"는 Excel에서 저장 후 다시 열어도 유지된다
 * (https://owasp.org/www-community/attacks/CSV_Injection).
 *
 * `="001"` 형태는 앞자리 0을 살리지만 **그 자체가 수식**이라 수식 주입 방어와 충돌하므로 쓰지 않는다.
 *
 * 이 함수는 **서버가 만든 제한된 값**(예: `[0-9]{3}` 쿠폰 번호)에만 쓴다. 사용자가 자유 입력한
 * 값에는 절대 쓰지 않는다 — 그쪽은 neutralizeFormula가 그대로 담당한다.
 */
export function excelText(value: string): CsvCell {
  return { raw: `\t${value}` };
}

/** toCsv가 수식 중화를 건너뛰고 그대로 내보낼 값. 호출자가 안전을 보장한다. */
export interface CsvRaw {
  raw: string;
}

export type CsvCell = string | number | null | undefined | CsvRaw;

function isRaw(value: CsvCell): value is CsvRaw {
  return typeof value === "object" && value !== null && "raw" in value;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const escape = (value: CsvCell): string => {
    if (value === null || value === undefined) return "";
    // number는 사용자 입력이 아니므로 수식 중화 대상이 아니다(음수 -1000이 '-1000이 되면 안 됨).
    // CsvRaw도 호출자가 안전을 보장한 서버 생성 값이므로 그대로 둔다.
    const str = isRaw(value)
      ? value.raw
      : typeof value === "number"
        ? String(value)
        : neutralizeFormula(String(value));
    if (/[",\n\r\t]/.test(str)) {
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
