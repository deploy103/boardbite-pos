/** 아주 단순한 CSV 직렬화 유틸 — 쉼표/줄바꿈/따옴표가 포함된 값은 RFC 4180 방식으로 이스케이프한다. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
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
