import ExcelJS from "exceljs";
import { inflateRawSync } from "node:zlib";
import { QUANTITIES, positiveInt, type Candidate } from "./types.js";
export function extractCode(value: string): string {
  const s = value.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(s)) return s;
  const codes = [
    ...s.matchAll(
      /(?:邀请码|INVITE\s*CODE)\s*[:：]\s*([A-Z0-9]{6})(?![A-Z0-9])/g,
    ),
  ].map((m) => m[1]);
  const unique = [...new Set(codes)];
  if (unique.length !== 1)
    throw Error(unique.length ? "检测到多个邀请码" : "未找到明确的六位邀请码");
  return unique[0];
}
function validateZip(b: Buffer) {
  if (b.length > 5 * 1024 * 1024) throw Error("文件不能超过 5 MiB");
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      e = i;
      break;
    }
  if (e < 0) throw Error("不是有效的 XLSX 文件");
  const count = b.readUInt16LE(e + 10),
    start = b.readUInt32LE(e + 16),
    directorySize = b.readUInt32LE(e + 12);
  if (
    b.readUInt16LE(e + 4) !== 0 ||
    b.readUInt16LE(e + 6) !== 0 ||
    b.readUInt16LE(e + 8) !== count ||
    start + directorySize !== e ||
    e + 22 + b.readUInt16LE(e + 20) !== b.length
  )
    throw Error("XLSX 目录结构异常");
  if (count > 4096 || count === 0 || start >= e)
    throw Error("XLSX 压缩结构不受支持");
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > e || b.readUInt32LE(p) !== 0x02014b50)
      throw Error("XLSX 目录损坏");
    const flags = b.readUInt16LE(p + 8),
      method = b.readUInt16LE(p + 10),
      size = b.readUInt32LE(p + 20),
      expected = b.readUInt32LE(p + 24),
      nameLen = b.readUInt16LE(p + 28),
      extra = b.readUInt16LE(p + 30),
      comment = b.readUInt16LE(p + 32),
      local = b.readUInt32LE(p + 42);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      expected > 20 * 1024 * 1024 ||
      local + 30 > start
    )
      throw Error("XLSX 压缩内容异常");
    if (b.readUInt32LE(local) !== 0x04034b50) throw Error("XLSX 本地目录损坏");
    const at =
      local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    if (at + size > start) throw Error("XLSX 内容越界");
    const data =
      method === 8
        ? inflateRawSync(b.subarray(at, at + size), {
            maxOutputLength: 20 * 1024 * 1024 - total,
          })
        : b.subarray(at, at + size);
    total += data.length;
    if (data.length !== expected || total > 20 * 1024 * 1024)
      throw Error("XLSX 解压后超过 20 MiB");
    p += 46 + nameLen + extra + comment;
  }
  if (p !== e) throw Error("XLSX 目录条目数量与结构不一致");
}
const aliases: Record<string, string> = {
  邀请码: "code",
  invite_code: "code",
  邀请文本: "text",
  invite_text: "text",
  充值量b: "quantity",
  quantity_b: "quantity",
  单笔费用上限idr: "maxCost",
  max_cost_idr: "maxCost",
  备注: "note",
  note: "note",
};
export async function parseWorkbook(b: Buffer): Promise<Candidate[]> {
  try {
    validateZip(b);
  } catch (e) {
    throw Error(`XLSX 校验失败：${(e as Error).message}`);
  }
  const w = new ExcelJS.Workbook();
  try {
    await w.xlsx.load(b as any);
  } catch {
    throw Error("XLSX 无法解析");
  }
  const sheet = w.worksheets[0];
  if (!sheet) throw Error("XLSX 没有工作表");
  if (sheet.rowCount > 1001) throw Error("最多导入 1,000 条数据");
  const columns: Record<string, number> = {};
  sheet.getRow(1).eachCell((c, n) => {
    const key = aliases[String(c.text).trim().toLowerCase()];
    if (key) {
      if (columns[key]) throw Error("列名重复");
      columns[key] = n;
    }
  });
  if (!columns.code && !columns.text)
    throw Error("列名必须包含“邀请码”或“邀请文本”");
  const seen = new Map<string, number>(),
    rows: Candidate[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    if (!row.hasValues) continue;
    const errors: string[] = [];
    const values: Record<string, string | number> = {};
    for (const [key, n] of Object.entries(columns)) {
      const c = row.getCell(n);
      if (c.value === null || c.value === undefined) continue;
      if (typeof c.value === "object") {
        errors.push(
          c.type === ExcelJS.ValueType.Formula
            ? "不允许公式字段"
            : "字段必须是纯文本或数字",
        );
        continue;
      }
      if (!["string", "number"].includes(typeof c.value)) {
        errors.push("字段类型不受支持");
        continue;
      }
      values[key] = c.value as string | number;
    }
    let code = "";
    try {
      code = extractCode(String(values.code || values.text || ""));
      if (
        values.code &&
        values.text &&
        extractCode(String(values.text)) !== code
      )
        errors.push("邀请码与邀请文本不一致");
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (code && seen.has(code))
      errors.push(`重复邀请码，首次出现在第 ${seen.get(code)} 行`);
    else if (code) seen.set(code, i);
    const q = values.quantity === undefined ? null : Number(values.quantity),
      cost = values.maxCost === undefined ? null : Number(values.maxCost);
    if (q !== null && !QUANTITIES.includes(q as any))
      errors.push("充值量只支持 1、5、10、15、20、30B");
    if (cost !== null && !positiveInt(cost))
      errors.push("费用上限必须为正整数 IDR");
    rows.push({
      row: i,
      code,
      quantity: q,
      maxCost: cost,
      note: String(values.note || "").slice(0, 500),
      errors,
    });
  }
  if (!rows.length) throw Error("没有可导入的数据");
  return rows;
}
export async function templateWorkbook() {
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet("充值清单");
  s.addRow(["邀请码", "邀请文本", "充值量B", "单笔费用上限IDR", "备注"]);
  s.addRow(["", "", "", "", "填写自己的邀请码；不会自动下单"]);
  s.columns.forEach((c) => (c.width = 25));
  return Buffer.from(await w.xlsx.writeBuffer());
}
