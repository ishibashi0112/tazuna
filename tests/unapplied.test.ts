import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moveToUnapplied } from "../src/infra/unapplied.ts";

describe("moveToUnapplied (§4.7 当てなかった changes.md の置き場)", () => {
  const now = new Date(2026, 10, 4, 9, 5, 7);
  const setup = (): { root: string; file: string; outside: string } => {
    const root = mkdtempSync(join(tmpdir(), "tazuna-unapplied-"));
    const dl = mkdtempSync(join(tmpdir(), "tazuna-unapplied-dl-"));
    const outside = mkdtempSync(join(tmpdir(), "tazuna-unapplied-out-"));
    const file = join(dl, "changes.md");
    writeFileSync(file, "## CHANGES\n", "utf8");
    return { root, file, outside };
  };

  it("日時を付けた名前で移し、同じ秒に重なれば番号を付ける", () => {
    const { root, file } = setup();
    const first = moveToUnapplied(root, file, now);
    expect(first).toBe(join(root, ".tazuna", "unapplied", "2026-11-04_090507_changes.md"));
    writeFileSync(file, "## CHANGES\n", "utf8");
    expect(moveToUnapplied(root, file, now)).toBe(join(root, ".tazuna", "unapplied", "2026-11-04_090507_2_changes.md"));
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("unapplied/ がプロジェクトの外を指す symlink なら移さない", () => {
    const { root, file, outside } = setup();
    mkdirSync(join(root, ".tazuna"));
    symlinkSync(outside, join(root, ".tazuna", "unapplied"));
    expect(() => moveToUnapplied(root, file, now)).toThrow("プロジェクトの外");
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("状態ディレクトリ自体がプロジェクトの外を指す symlink でも移さない", () => {
    const { root, file, outside } = setup();
    symlinkSync(outside, join(root, ".tazuna"));
    expect(() => moveToUnapplied(root, file, now)).toThrow("プロジェクトの外");
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });
});
