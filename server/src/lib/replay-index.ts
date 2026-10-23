import fs from 'fs';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * 回放索引工具。
 *
 * 回放本体仍是 `records/<replayId>.json`，这里只负责把「谁、什么时候、什么地图」抽出来
 * 写进 `ReplayRecord` 表，供 `GET /replays?username=&from=&to=` 查询。
 *
 * 回放文件结构固定为
 * `{"players":[{...}],"mapWidth":N,"mapHeight":N,"gameRecordTurns":[...],"messagesRecord":[...]}`，
 * players/mapWidth/mapHeight 在最前面，因此只需读文件头就能解析，不必把 4GB 历史回放全部 JSON.parse。
 */

/** 回放 id 即 records/ 下的文件名，8 位小写字母数字，读取前必须校验（防路径穿越） */
export const REPLAY_ID_RE = /^[a-z0-9]{1,16}$/i;

/** 一次性读取的文件头长度；正常回放的 players 数组远小于该值 */
const HEAD_BYTES = 64 * 1024;

export interface ReplayMeta {
  players: string[];
  mapWidth: number;
  mapHeight: number;
}

export interface ReplayIndexRow {
  replayId: string;
  playedAt: Date;
  players: string[];
  mapWidth: number;
  mapHeight: number;
}

function parseHead(head: string): ReplayMeta | null {
  const playersKey = '"players":';
  const mapWidthKey = '"mapWidth"';
  const mapHeightKey = '"mapHeight"';

  const playersStart = head.indexOf(playersKey);
  const mapWidthStart = head.indexOf(mapWidthKey);
  const mapHeightStart = head.indexOf(mapHeightKey);
  if (playersStart < 0 || mapWidthStart < 0 || mapHeightStart < 0) return null;

  const playersRaw = head
    .slice(playersStart + playersKey.length, mapWidthStart)
    .trim()
    .replace(/,\s*$/, '');
  const mapWidthRaw = head.slice(mapWidthStart + mapWidthKey.length, mapHeightStart).trim().replace(/^:\s*/, '').replace(/,\s*$/, '');
  const mapHeightRaw = head.slice(mapHeightStart + mapHeightKey.length).trim().replace(/^:\s*/, '');

  const parsedPlayers = JSON.parse(playersRaw) as Array<{ username?: unknown }>;
  const mapWidth = Number.parseInt(mapWidthRaw, 10);
  const mapHeight = Number.parseInt(mapHeightRaw, 10);
  if (!Array.isArray(parsedPlayers) || !Number.isFinite(mapWidth) || !Number.isFinite(mapHeight)) {
    return null;
  }

  const players = parsedPlayers
    .map((p) => (typeof p?.username === 'string' ? p.username.trim() : ''))
    .filter((name) => name.length > 0);

  return { players, mapWidth, mapHeight };
}

/**
 * 从回放文件解析出索引所需的元信息。
 * 优先只读文件头；文件头解析失败（异常回放/超长玩家列表）时回退到整文件解析。
 */
export function readReplayMeta(filePath: string): ReplayMeta | null {
  let fd: number | undefined;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const fromHead = parseHead(buffer.subarray(0, bytesRead).toString('utf8'));
    if (fromHead) return fromHead;
  } catch (error) {
    console.error(`[replay-index] failed to read head of ${filePath}`, error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  try {
    const replay = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      players?: Array<{ username?: unknown }>;
      mapWidth?: unknown;
      mapHeight?: unknown;
    };
    const players = (replay.players ?? [])
      .map((p) => (typeof p?.username === 'string' ? p.username.trim() : ''))
      .filter((name) => name.length > 0);
    return {
      players,
      mapWidth: Number(replay.mapWidth) || 0,
      mapHeight: Number(replay.mapHeight) || 0,
    };
  } catch (error) {
    console.error(`[replay-index] failed to parse ${filePath}`, error);
    return null;
  }
}

/** 写入（幂等：重复索引同一 replayId 直接跳过） */
export async function indexReplay(prisma: PrismaClient, row: ReplayIndexRow): Promise<void> {
  await prisma.replayRecord.createMany({
    data: [
      {
        replayId: row.replayId,
        playedAt: row.playedAt,
        players: row.players,
        mapWidth: row.mapWidth,
        mapHeight: row.mapHeight,
      } satisfies Prisma.ReplayRecordCreateManyInput,
    ],
    skipDuplicates: true,
  });
}
