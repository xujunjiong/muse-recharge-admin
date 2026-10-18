import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { extractCode, parseWorkbook } from "../src/importer.js";
const book = async (rows: unknown[][]) => {
  const w = new ExcelJS.Workbook();
  w.addWorksheet("账户").addRows(rows);
  return Buffer.from(await w.xlsx.writeBuffer());
};
test("extracts only explicit single code or plain code", () => {
  assert.equal(
    extractCode("快来看看 Muse\n邀请码：ab12cd\nhttps://muse.ai/join"),
    "AB12CD",
  );
  assert.throws(() => extractCode("random AB12CD somewhere"));
  assert.throws(() => extractCode("邀请码：AB12CD Invite code: EF34GH"));
});
test("xlsx validates duplicate, conflict and formula rows", async () => {
  const rows = await parseWorkbook(
    await book([
      ["邀请码", "邀请文本", "充值量B", "单笔费用上限IDR"],
      ["AB12CD", "", 1, 1700],
      ["ab12cd", "", 1, 1700],
      ["EF34GH", "邀请码：JK56LM", 1, 1700],
      [{ formula: '"AB12CD"' }, "", 1, 1700],
    ]),
  );
  assert.equal(rows.length, 4);
  assert.equal(rows[0].code, "AB12CD");
  assert.equal(rows[0].errors.length, 0);
  assert.match(rows[1].errors.join(), /重复/);
  assert.match(rows[2].errors.join(), /不一致/);
  assert.match(rows[3].errors.join(), /公式/);
});
test("rejects oversized and invalid archives", async () => {
  await assert.rejects(
    parseWorkbook(Buffer.alloc(5 * 1024 * 1024 + 1)),
    /5 MiB/,
  );
  await assert.rejects(parseWorkbook(Buffer.from("bad zip")), /XLSX/);
});
test("does not accept unknown columns and fractional budgets", async () => {
  await assert.rejects(
    parseWorkbook(await book([["其他"], ["AB12CD"]])),
    /列名/,
  );
  const r = await parseWorkbook(
    await book([
      ["invite_code", "quantity_b", "max_cost_idr"],
      ["AB12CD", 1, 1.2],
    ]),
  );
  assert.match(r[0].errors.join(), /费用/);
});
test("rejects forged EOCD counts hiding unvalidated directory entries", async () => {
  const b = await book([["邀请码"], ["AB12CD"]]);
  let e = b.length - 22;
  while (e > 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  b.writeUInt16LE(1, e + 8);
  b.writeUInt16LE(1, e + 10);
  await assert.rejects(parseWorkbook(b), /XLSX.*目录|XLSX.*结构/);
});
