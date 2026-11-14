import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWatchLock, checkWatchLock, releaseWatchLock, watchLockPath } from "../src/infra/watch-lock.ts";

describe("watch の印 (§4.7 同じダウンロードフォルダを見る watch は 1 つだけ)", () => {
  const setup = (): { lockDir: string; path: string } => {
    const lockDir = mkdtempSync(join(tmpdir(), "tazuna-watch-lock-"));
    return { lockDir, path: watchLockPath("/home/u/Downloads", lockDir) };
  };
  const me = (root: string, pid = process.pid) => ({ pid, root, startedAt: "2026-11-14T10:00:00.000Z" });

  it("ダウンロードフォルダごとに 1 つ。Windows・macOS は大文字小文字の違いを同じフォルダとみなす", () => {
    const dir = "/x";
    expect(watchLockPath("/home/u/Downloads", dir, "linux")).not.toBe(watchLockPath("/home/u/downloads", dir, "linux"));
    expect(watchLockPath("/home/u/Downloads", dir, "darwin")).toBe(watchLockPath("/home/u/downloads", dir, "darwin"));
    expect(watchLockPath("/home/u/Downloads", dir, "linux")).not.toBe(watchLockPath("/home/u/Other", dir, "linux"));
    expect(watchLockPath("/home/u/Downloads", dir)).toMatch(/[\\/]tazuna-watch-[0-9a-f]{16}\.json$/);
  });

  it("後から始めた watch が印を置き換え、前の watch は切り替わったと分かる", () => {
    const { path } = setup();
    const a = acquireWatchLock(path, me("/work/A"));
    expect(a.previous).toBeNull();
    expect(checkWatchLock(a.lock, me("/work/A"))).toEqual({ state: "mine" });

    const b = acquireWatchLock(path, me("/work/B"));
    expect(b.previous).toEqual({ ...me("/work/A"), alive: true });
    expect(checkWatchLock(a.lock, me("/work/A"))).toEqual({ state: "taken", by: me("/work/B") });
    expect(checkWatchLock(b.lock, me("/work/B"))).toEqual({ state: "mine" });

    // 切り替わった側の終了では、新しい watch の印を消さない
    releaseWatchLock(a.lock);
    expect(existsSync(path)).toBe(true);
    releaseWatchLock(b.lock);
    expect(existsSync(path)).toBe(false);
  });

  it("前の watch のプロセスが無い・印が長く更新されていないときは、動いていないとみなす", () => {
    const { path } = setup();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid as number;
    acquireWatchLock(path, me("/work/A", gone));
    expect(acquireWatchLock(path, me("/work/B")).previous?.alive).toBe(false);

    acquireWatchLock(path, me("/work/A"));
    const later = statSync(path).mtimeMs + 61_000;
    expect(acquireWatchLock(path, me("/work/B"), later).previous?.alive).toBe(false);
  });

  it("動いている watch はときどき印の更新時刻を新しくする", () => {
    const { path } = setup();
    const { lock } = acquireWatchLock(path, me("/work/A"));
    const old = new Date(Date.now() - 30_000);
    utimesSync(path, old, old);
    checkWatchLock(lock, me("/work/A"));
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5_000);
  });

  it("印が消されていれば書き直し、壊れた印は置き換える", () => {
    const { path } = setup();
    const { lock } = acquireWatchLock(path, me("/work/A"));
    releaseWatchLock(lock);
    expect(checkWatchLock(lock, me("/work/A"))).toEqual({ state: "mine" });
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.token);

    writeFileSync(path, "{ broken", "utf8");
    expect(checkWatchLock(lock, me("/work/A"))).toEqual({ state: "unknown" });
    const next = acquireWatchLock(path, me("/work/B"));
    expect(next.previous).toBeNull();
    expect(checkWatchLock(next.lock, me("/work/B"))).toEqual({ state: "mine" });
  });

  it.skipIf(process.platform === "win32")("印の場所に symlink が置かれていても、その先を書き換えない", () => {
    const { lockDir, path } = setup();
    const victim = join(lockDir, "victim.txt");
    writeFileSync(victim, "keep", "utf8");
    symlinkSync(victim, path);
    const { lock } = acquireWatchLock(path, me("/work/A"));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(checkWatchLock(lock, me("/work/A"))).toEqual({ state: "mine" });
  });
});
