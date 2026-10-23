/**
 * 回放索引回填 / 增量同步脚本。
 *
 * 用途：records/ 里已有 56 万+ 历史回放文件，但 ReplayRecord 索引表是后加的，
 * 需要把历史数据补进去；日常新对局由 server.ts 在落盘时自动索引，本脚本也支持增量补漏。
 *
 * 用法（在 server/ 目录下）：
 *   npx ts-node scripts/index-replays.ts                    # 全量回填
 *   npx ts-node scripts/index-replays.ts --since 2026-10-01 # 只补最近的回放（按文件 mtime）
 *   npx ts-node scripts/index-replays.ts --dry-run          # 只统计不写库
 *   npx ts-node scripts/index-replays.ts --records /path/to/records --batch 2000
 */
import fs from 'fs';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { readReplayMeta } from '../src/lib/replay-index';

interface ScriptArgs {
  recordsDir: string;
  since: Date | null;
  batchSize: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    recordsDir: path.join(process.cwd(), 'records'),
    since: null,
    batchSize: 1000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--records': {
        const value = argv[++i];
        if (!value) throw new Error('--records 需要目录参数');
        args.recordsDir = path.resolve(value);
        break;
      }
      case '--since': {
        const value = argv[++i];
        if (!value) throw new Error('--since 需要时间参数，如 2026-10-01 或 ISO8601');
        const since = new Date(value);
        if (Number.isNaN(since.getTime())) throw new Error(`无法解析 --since: ${value}`);
        args.since = since;
        break;
      }
      case '--batch': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error('--batch 需为 1~10000 的整数');
        args.batchSize = value;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  return args;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.recordsDir)) {
    throw new Error(`records 目录不存在: ${args.recordsDir}`);
  }

  const prisma = new PrismaClient();
  const startedAt = Date.now();

  const files = fs.readdirSync(args.recordsDir).filter((file) => file.endsWith('.json'));
  console.log(
    `records: ${args.recordsDir}，共 ${files.length} 个文件` +
      `，since=${args.since ? args.since.toISOString() : '不限'}` +
      `，batch=${args.batchSize}${args.dryRun ? '，dry-run' : ''}`
  );

  let scanned = 0;
  let filteredBySince = 0;
  let indexed = 0;
  let failed = 0;
  let pending: Prisma.ReplayRecordCreateManyInput[] = [];

  const flush = async () => {
    if (!pending.length) return;
    if (!args.dryRun) {
      await prisma.replayRecord.createMany({ data: pending, skipDuplicates: true });
    }
    indexed += pending.length;
    pending = [];
  };

  for (const file of files) {
    scanned += 1;
    const filePath = path.join(args.recordsDir, file);
    const stat = fs.statSync(filePath);

    if (args.since && stat.mtime < args.since) {
      filteredBySince += 1;
      continue;
    }

    const meta = readReplayMeta(filePath);
    if (!meta) {
      failed += 1;
      console.warn(`[skip] 无法解析回放: ${file}`);
      continue;
    }

    pending.push({
      replayId: path.basename(file, '.json'),
      playedAt: stat.mtime,
      players: meta.players,
      mapWidth: meta.mapWidth,
      mapHeight: meta.mapHeight,
    });

    if (pending.length >= args.batchSize) await flush();
    if (scanned % 20000 === 0) {
      console.log(
        `  进度 ${scanned}/${files.length}，已索引 ${indexed}，失败 ${failed}，` +
          `耗时 ${formatDuration(Date.now() - startedAt)}`
      );
    }
  }

  await flush();
  const totalRows = args.dryRun ? 0 : await prisma.replayRecord.count().catch(() => 0);
  await prisma.$disconnect();
  console.log('---');
  console.log(`扫描文件: ${scanned}`);
  console.log(`按 --since 跳过: ${filteredBySince}`);
  console.log(`写入索引: ${indexed}${args.dryRun ? '（dry-run 未写库）' : ''}`);
  console.log(`解析失败: ${failed}`);
  console.log(`耗时: ${formatDuration(Date.now() - startedAt)}`);
  if (!args.dryRun) console.log(`ReplayRecord 当前总行数: ${totalRows}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
