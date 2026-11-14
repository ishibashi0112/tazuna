/**
 * tazuna watch の印 (同じダウンロードフォルダを見る watch を 1 つにする。§4.7)。
 *
 * 同じ Downloads を 2 つの watch が見ていると、届いた 1 つの changes.md を両方が同時に読み、
 * 両方のリポジトリに当ててしまう (2026-11-14 利用者の事例。同じプロジェクトの 2 か所で watch を起動していた)。
 * そこで watch は始めるときに一時フォルダへ印 (リポジトリ・PID・開始時刻・その watch だけが知る合言葉) を書き、
 * 前の印を置き換える。前の watch は約 1 秒ごとに印を読み、自分の合言葉でなくなっていたら終了する
 * (後から始めた watch に切り替わる)。
 *
 * - 印は置き換えるだけなので、ウィンドウを閉じて残った印のせいで watch を始められなくなることはない
 * - 印の場所は一時フォルダ (Windows は %TEMP%)。Downloads のフォルダごとに 1 つ (名前はフォルダのパスのハッシュ)
 * - 動いている watch は約 10 秒ごとに印の更新時刻を新しくする。前の watch がまだ動いているか (切り替えたことを
 *   表示するか) は、PID の存在と更新時刻で見る (PID は使い回されることがあるため)
 * - 置き換えは別名に書いてから rename (途中の印を読ませない。既にあるものが symlink でもその先を書き換えない)
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TOOL_NAME } from "../brand.ts";

/** 印に書く内容 */
export interface WatchLockInfo {
  /** その watch だけが知る合言葉 (同じプロセスの中の 2 つの watch も見分ける) */
  token: string;
  pid: number;
  /** その watch のプロジェクトのルート */
  root: string;
  /** 開始時刻 (ISO 8601) */
  startedAt: string;
}

export interface WatchLock {
  path: string;
  token: string;
}

/** 前に動いていた watch (の印) */
export interface PreviousWatch extends Omit<WatchLockInfo, "token"> {
  /** まだ動いていそうか (PID があり、印の更新が新しい) */
  alive: boolean;
}

/** 動いている watch が印の更新時刻を新しくする間隔 */
const HEARTBEAT_MS = 10_000;
/** これより長く更新されていない印は、PID があっても止まった watch のものとみなす */
const STALE_MS = 60_000;

/** 同じフォルダを同じ文字列にする (Windows・macOS は大文字小文字を区別しないのが普通) */
function normalizeDir(dir: string, platform: NodeJS.Platform): string {
  let path = resolve(dir);
  try {
    path = realpathSync(path);
  } catch {
    // まだ無いフォルダは、そのままのパスで見る
  }
  return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
}

/** Downloads のフォルダごとの印のパス。共有の /tmp でほかのユーザーと重ならないよう uid も混ぜる */
export function watchLockPath(
  downloadsDir: string,
  lockDir: string = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const key = createHash("sha256").update(`${uid}\0${normalizeDir(downloadsDir, platform)}`).digest("hex").slice(0, 16);
  return join(lockDir, `${TOOL_NAME}-watch-${key}.json`);
}

type ReadResult = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; info: WatchLockInfo; mtimeMs: number };

/** 印を読む。通常のファイルでない・自分のものでない (共有の /tmp)・形の違うものは invalid */
function readLock(path: string): ReadResult {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isFile()) return { kind: "invalid" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { kind: "invalid" };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (typeof value !== "object" || value === null) return { kind: "invalid" };
  const v = value as Record<string, unknown>;
  if (
    typeof v["token"] !== "string" ||
    typeof v["pid"] !== "number" ||
    !Number.isInteger(v["pid"]) ||
    typeof v["root"] !== "string" ||
    typeof v["startedAt"] !== "string"
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ok",
    info: { token: v["token"], pid: v["pid"], root: v["root"], startedAt: v["startedAt"] },
    mtimeMs: st.mtimeMs,
  };
}

/** PID のプロセスがあるか (別のユーザーのプロセスなら EPERM で、あるとみなす) */
function processExists(pid: number): boolean {
  if (pid === process.pid) return true;
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 短く待つ (印の置き換えで、相手がちょうど読んでいて rename できなかったときの再試行用) */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 別名に書いてから rename で置き換える。Windows で相手が読んでいる瞬間は rename できないことがあるので少し再試行する */
function replaceLock(path: string, info: WatchLockInfo): void {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // wx: 既にあれば失敗する (推測できない名前なので、先に置かれた symlink を辿らない)
  writeFileSync(temp, JSON.stringify(info), { encoding: "utf8", flag: "wx", mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 10 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        pause(20);
        continue;
      }
      rmSync(temp, { force: true });
      throw e;
    }
  }
}

/**
 * 印を書き (前の印を置き換え)、前に動いていた watch の情報を返す。
 * 書けなければ例外 (呼び出し側は警告して印なしで続ける)
 */
export function acquireWatchLock(
  path: string,
  me: Omit<WatchLockInfo, "token">,
  now: number = Date.now(),
): { lock: WatchLock; previous: PreviousWatch | null } {
  const before = readLock(path);
  const previous: PreviousWatch | null =
    before.kind === "ok"
      ? {
          pid: before.info.pid,
          root: before.info.root,
          startedAt: before.info.startedAt,
          alive: processExists(before.info.pid) && now - before.mtimeMs < STALE_MS,
        }
      : null;
  const token = randomBytes(16).toString("hex");
  replaceLock(path, { ...me, token });
  return { lock: { path, token }, previous };
}

export type WatchLockCheck = { state: "mine" } | { state: "taken"; by: Omit<WatchLockInfo, "token"> } | { state: "unknown" };

/**
 * 印がまだ自分のものか。別の watch の印に置き換わっていれば "taken"。
 * 無くなっていれば (一時フォルダの掃除など) 書き直して "mine"。読めないときは "unknown" (次の観測で見直す)。
 * 自分の印なら、ときどき更新時刻を新しくする (まだ動いていることを後から始めた watch に示す)
 */
export function checkWatchLock(lock: WatchLock, me: Omit<WatchLockInfo, "token">, now: number = Date.now()): WatchLockCheck {
  const current = readLock(lock.path);
  if (current.kind === "missing") {
    try {
      // wx: その間に別の watch が書いていたら、そちらを残す (次の観測で切り替わったと分かる)
      writeFileSync(lock.path, JSON.stringify({ ...me, token: lock.token }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return { state: "mine" };
    } catch {
      return { state: "unknown" };
    }
  }
  if (current.kind === "invalid") return { state: "unknown" };
  if (current.info.token !== lock.token) {
    const { token: _token, ...by } = current.info;
    return { state: "taken", by };
  }
  if (now - current.mtimeMs >= HEARTBEAT_MS) {
    try {
      const at = new Date(now);
      utimesSync(lock.path, at, at);
    } catch {
      // 更新できなくても困らない (後から始めた watch の表示が変わるだけ)
    }
  }
  return { state: "mine" };
}

/** 終了時に印を消す (自分の印のときだけ。切り替わった後は、新しい watch の印を残す) */
export function releaseWatchLock(lock: WatchLock): void {
  const current = readLock(lock.path);
  if (current.kind !== "ok" || current.info.token !== lock.token) return;
  try {
    unlinkSync(lock.path);
  } catch {
    // 消せなくても、次の watch が置き換える
  }
}
