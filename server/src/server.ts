import express from 'express';
import { Request, Response } from 'express';
import { Server, Socket } from 'socket.io';
import xss from 'xss';
import crypto from 'crypto';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

import { ColorArr, MaxTeamNum, forceStartOK } from './lib/constants';
import { roomPool, createRoom } from './lib/room-pool';
import { Room, initGameInfo, CustomMapData, MapDiffData, LeaderBoardTable, LeaderBoardRow } from './lib/types';
import { getPlayerIndex, getPlayerIndexBySocket } from './lib/utils';
import Point from './lib/point';
import Player from './lib/player';
import GameMap from './lib/map';
import MapDiff from './lib/map-diff';
import GameRecord from './lib/game-record';
import { REPLAY_ID_RE, indexReplay } from './lib/replay-index';

dotenv.config();

if (!process.env.CLIENT_URL || !process.env.PORT) {
  throw new Error('Please fill in `CLIENT_URL` and `PORT`.');
}

const prisma = new PrismaClient();
const app = express();
const cors_urls = process.env.CLIENT_URL == '*' ? '*' : process.env.CLIENT_URL.split(' ');
console.log(cors_urls);

app.use(express.json());
app.use(cors({ origin: cors_urls }));

app.get('/', (req: Request, res: Response) => {
  res.status(200).json('');
});

app.get('/ping', (req: Request, res: Response) => {
  res.status(200).json('');
});

app.get('/get_rooms', (req: Request, res: Response) => {
  res.status(200).json(roomPool);
});

app.get('/create_room', async (req: Request, res: Response) => {
  let result = await createRoom();
  if (result.success) {
    res.status(200).json(result);
  } else {
    res.status(500).json(result);
  }
});

app.get('/get_replay/:replayId', async (req: Request, res: Response) => {
  const replayId = req.params.replayId;
  // replayId 直接参与拼路径，必须校验，否则可用 ../ 读取 records/ 之外的 JSON 文件
  if (!REPLAY_ID_RE.test(replayId)) {
    res.status(400).json({ error: 'Invalid replayId' });
    return;
  }
  const replayFilePath = path.join(process.cwd(), 'records', `${replayId}.json`);

  fs.readFile(replayFilePath, 'utf8', (err, data) => {
    if (err) {
      console.error(err);
      res.status(404).json({ error: 'Replay not found' });
    } else {
      try {
        const replayData = JSON.parse(data);
        res.status(200).json(replayData);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to parse replay data' });
      }
    }
  });
});

// GET /replays?username=xxx&from=2026-10-01&to=2026-10-23&limit=20&offset=0
// 按「用户名 + 可选时间区间」查询回放列表。数据来自 ReplayRecord 索引表，不扫 records/ 文件。
const REPLAY_DEFAULT_LIMIT = 20;
const REPLAY_MAX_LIMIT = 100;
const REPLAY_MAX_USERNAME_LENGTH = 32;

/**
 * 解析 from/to：支持 YYYY-MM-DD 与完整 ISO8601。
 * YYYY-MM-DD 按服务器本地时区解释，from 取当天 00:00:00.000、to 取当天 23:59:59.999。
 */
function parseReplayDateParam(value: string, endOfDay: boolean): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = endOfDay ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day);
    // new Date(2026, 1, 31) 会自动进位到 3 月，借此识别 2026-02-31 这类非法日期
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseReplayIntParam(value: unknown, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return Number(value);
}

app.get('/replays', async (req: Request, res: Response) => {
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (!username) {
    res.status(400).json({ success: false, error: '`username` is required' });
    return;
  }
  if (username.length > REPLAY_MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(username)) {
    res.status(400).json({ success: false, error: 'Invalid `username`' });
    return;
  }

  const rawFrom = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const rawTo = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  const from = rawFrom ? parseReplayDateParam(rawFrom, false) : null;
  const to = rawTo ? parseReplayDateParam(rawTo, true) : null;
  if ((rawFrom && !from) || (rawTo && !to)) {
    res.status(400).json({ success: false, error: 'Invalid `from`/`to`, expected YYYY-MM-DD or ISO8601' });
    return;
  }
  if (from && to && from > to) {
    res.status(400).json({ success: false, error: '`from` must not be later than `to`' });
    return;
  }

  const limit = parseReplayIntParam(req.query.limit, REPLAY_DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > REPLAY_MAX_LIMIT) {
    res.status(400).json({ success: false, error: `\`limit\` must be an integer between 1 and ${REPLAY_MAX_LIMIT}` });
    return;
  }
  const offset = parseReplayIntParam(req.query.offset, 0);
  if (offset === null) {
    res.status(400).json({ success: false, error: 'Invalid `offset`' });
    return;
  }

  const where: Prisma.ReplayRecordWhereInput = { players: { has: username } };
  if (from || to) {
    where.playedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  try {
    const [total, replays] = await prisma.$transaction([
      prisma.replayRecord.count({ where }),
      prisma.replayRecord.findMany({
        where,
        orderBy: { playedAt: 'desc' },
        skip: offset,
        take: limit,
        select: { replayId: true, playedAt: true, players: true, mapWidth: true, mapHeight: true },
      }),
    ]);
    res.status(200).json({
      success: true,
      username,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      total,
      limit,
      offset,
      replays,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Failed to query replays' });
  }
});

app.delete('/rooms/:roomId', async (req: Request, res: Response) => {
  const roomId = req.params.roomId;
  if (!roomPool[roomId]) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const room = roomPool[roomId];

  // 如果游戏正在进行，停止游戏循环
  if (room.gameStarted && room.gameLoop) {
    clearInterval(room.gameLoop);
  }

  // 通知所有玩家房间被删除
  if (io) {
    io.in(roomId).emit('room_deleted', 'Room has been deleted by admin');
    io.in(roomId).disconnectSockets(true);
  }
  // 从房间池中删除房间
  delete roomPool[roomId];

  console.log(`Room ${roomId} deleted by admin API`);
  res.status(200).json({ success: true, message: `Room ${roomId} deleted successfully` });
});

app.get('/maps', async (req, res) => {
  const maps = await prisma.customMapData.findMany({
    select: {
      id: true,
      name: true,
      width: true,
      height: true,
      creator: true,
      description: true,
      createdAt: true,
      views: true,
      starCount: true,
    },
  });
  res.json(maps);
});

app.post('/maps', async (req, res) => {
  try {
    await prisma.customMapData.create({
      data: {
        ...req.body,
        mapTilesData: JSON.stringify(req.body.mapTilesData),
      },
    });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

app.get('/maps/:id', async (req, res) => {
  const map = await prisma.customMapData.findUnique({
    where: { id: req.params.id },
  });
  if (!map) return res.status(404).end(); // Not Found
  await prisma.customMapData.update({
    where: { id: req.params.id },
    data: {
      views: {
        increment: 1,
      },
    },
  });
  map.mapTilesData = JSON.parse(map.mapTilesData);
  res.json(map);
});

app.put('/maps/:id', async (req, res) => {
  const updatedMap = await prisma.customMapData.update({
    where: { id: req.params.id },
    data: {
      ...req.body,
      mapTilesData: JSON.stringify(req.body.mapTilesData),
    },
  });
  res.json(updatedMap);
});

app.delete('/maps/:id', async (req, res) => {
  const deletedMap = await prisma.customMapData.delete({
    where: { id: req.params.id },
  });
  res.json(deletedMap);
});

app.get('/new', async (req, res) => {
  const newestMaps = await prisma.customMapData.findMany({
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      name: true,
      width: true,
      height: true,
      creator: true,
      description: true,
      createdAt: true,
      views: true,
      starCount: true,
    },
  });
  res.json(newestMaps);
});

app.get('/best', async (req, res) => {
  const bestMaps = await prisma.customMapData.findMany({
    orderBy: { starCount: 'desc' },
    take: 25,
    select: {
      id: true,
      name: true,
      width: true,
      height: true,
      creator: true,
      description: true,
      createdAt: true,
      views: true,
      starCount: true,
    },
  });
  res.json(bestMaps);
});

app.get('/hot', async (req, res) => {
  const hotMaps = await prisma.customMapData.findMany({
    orderBy: { views: 'desc' },
    take: 25,
    select: {
      id: true,
      name: true,
      width: true,
      height: true,
      creator: true,
      description: true,
      createdAt: true,
      views: true,
      starCount: true,
    },
  });
  res.json(hotMaps);
});

app.get('/search', async (req: Request, res: Response) => {
  const searchTerm = req.query.q;

  if (typeof searchTerm !== 'string') {
    res.status(400).json({ error: 'Invalid query parameter' });
    return;
  }

  const searchedMaps = await prisma.customMapData.findMany({
    where: {
      OR: [{ name: { contains: searchTerm } }, { id: { equals: searchTerm } }],
    },
    select: {
      id: true,
      name: true,
      width: true,
      height: true,
      creator: true,
      description: true,
      createdAt: true,
      views: true,
      starCount: true,
    },
  });
  res.json(searchedMaps);
});

app.post('/toggleStar', async (req: Request, res: Response) => {
  const { userId, mapId, action } = req.body;

  if (action !== 'increase' && action !== 'decrease') {
    res.status(400).json({ error: 'Invalid action' });
    return;
  }

  const existingStar = await prisma.starUsers.findUnique({
    where: { userId_mapId: { userId, mapId } },
  });

  if (action === 'increase') {
    if (existingStar) {
      res.status(400).json({ error: 'You have already starred this map' });
      return;
    }

    await prisma.$transaction([
      prisma.starUsers.create({ data: { userId, mapId } }),
      prisma.customMapData.update({ where: { id: mapId }, data: { starCount: { increment: 1 } } }),
    ]);
  } else {
    if (!existingStar) {
      res.status(400).json({ error: 'You have not starred this map yet' });
      return;
    }

    await prisma.$transaction([
      prisma.starUsers.delete({ where: { userId_mapId: { userId, mapId } } }),
      prisma.customMapData.update({ where: { id: mapId }, data: { starCount: { decrement: 1 } } }),
    ]);
  }

  res.json({ success: true });
});

app.get('/starredMaps', async (req, res) => {
  const userId = req.query.userId as string;

  if (!userId) {
    res.status(400).json({ error: 'User ID is required' });
    return;
  }

  const starredMaps = await prisma.starUsers.findMany({
    where: { userId },
    select: { mapId: true },
  });

  res.json(starredMaps.map((starUsers) => starUsers.mapId));
});

const server = app.listen(process.env.PORT, () => {
  console.log(`Application started on port ${process.env.PORT}!`);
});

const io = new Server(server, {
  cors: {
    origin: cors_urls,
  }
});

function handleNeutralized(room: Room, player: Player) {
  if (player.king) {
    room.map.getBlock(player.king).kingBeDominated();
  } else {
    console.log('Error! king is null', player);
  }
  // 变成中立单元: todo 延迟一段时间再变为中立单元更合理
  player.land.forEach((block) => {
    block.beNeutralized();
  });
  player.land.length = 0;
  player.king = null;
  player.isDead = true;
}

async function handleDisconnectInRoom(room: Room, player: Player, io: Server) {
  try {
    io.in(room.id).emit('room_message', player, 'quit.');
    if (room.gameStarted && !player.spectating()) {
      player.disconnected = true;
      handleNeutralized(room, player);
    } else {
      room.players = room.players.filter((p) => p.id != player.id);
    }

    // 重新计算forceStartNum：只计算非机器人玩家的准备数量
    room.forceStartNum = room.players.filter((p) =>
      !p.spectating() && !p.isBot && p.forceStart
    ).length;

    if (room.players.length < 1 && !room.keepAlive) {
      delete roomPool[room.id];
    } else {
      if (room.players[0]) room.players[0].setRoomHost(true);
    }
    io.in(room.id).emit('update_room', room);
  } catch (e: any) {
    console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
    console.log(e.stack);
  }
}

async function endRoomGame(room: Room, io: Server, reason: string = 'Game ended by host') {
  try {
    // 如果游戏正在进行，停止游戏循环
    if (room.gameStarted && room.gameLoop) {
      clearInterval(room.gameLoop);
      room.gameStarted = false;
    }

    // 重置所有玩家状态
    room.players.forEach((player) => {
      player.reset();
      player.disconnected = false;
    });

    // 重置房间状态
    room.forceStartNum = 0;
    room.mapGenerated = false;
    room.map = null;
    room.globalMapDiff = null;
    room.gameRecord = null;

    // 通知所有玩家游戏结束
    io.in(room.id).emit('room_message', null, reason);
    io.in(room.id).emit('update_room', room);

    // 发送game_ended事件，让客户端显示游戏结束对话框
    io.in(room.id).emit('game_ended', [], ''); // 空数组表示没有胜利者，空字符串表示没有回放链接

    console.log(`Room ${room.id} game ended: ${reason}`);
  } catch (e: any) {
    console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
    console.log(e.stack);
  }
}

async function checkForcedStart(room: Room, io: Server) {
  // 计算非机器人玩家数量
  const humanPlayers = room.players.filter((player) => !player.spectating() && !player.isBot);
  const botPlayers = room.players.filter((player) => !player.spectating() && player.isBot);

  // 检查是否所有人类玩家都是观战者
  const allHumanSpectators = room.players.filter(p => !p.isBot).every(p => p.spectating());

  // 特殊边界情况处理
  let forceStartNum;

  if (allHumanSpectators) {
    // 情况0：所有人类都是观战者 - 需要房主手动开始
    forceStartNum = Infinity; // 设置为无限大，防止自动开始
  } else if (humanPlayers.length === 0 && botPlayers.length > 1) {
    // 情况1：没有人类玩家但有多个机器人 - 满足开始条件
    forceStartNum = 0;
  } else if (humanPlayers.length === 1 && botPlayers.length > 0) {
    // 情况2：只有1个人类玩家但有机器人 - 满足开始条件
    forceStartNum = 1;
  } else {
    // 正常情况：根据人类玩家数量决定强制开始阈值
    forceStartNum = forceStartOK[humanPlayers.length];
  }

  // 计算非机器人玩家的强制开始数量
  const humanForceStartNum = room.players.filter((player) =>
    !player.spectating() && !player.isBot && player.forceStart
  ).length;

  if (!room.gameStarted && humanForceStartNum >= forceStartNum) {
    await handleGame(room, io);
  }
}

async function handleGame(room: Room, io: Server) {
  if (room.gameStarted === false) {
    room.players.forEach((player) => {
      player.reset();
    });

    if (room.mapId) {
      const data = await prisma.customMapData.findUnique({
        where: { id: room.mapId },
      });
      if (!data) {
        throw new Error('Map not found');
      }
      console.log(`Start game with custom map ${room.mapId} ${data.name}`);

      const customMapData = {
        ...data,
        mapTilesData: JSON.parse(data.mapTilesData),
      };
      room.map = GameMap.from_custom_map(customMapData, room.players, room.revealKing);
    } else {
      let actualWidth = Math.ceil(Math.sqrt(room.players.length) * 5 + 15 * room.mapWidth);
      let actualHeight = Math.ceil(Math.sqrt(room.players.length) * 5 + 15 * room.mapHeight);
      room.map = new GameMap(
        'random_map_id',
        'random_map_name',
        actualWidth,
        actualHeight,
        room.mountain,
        room.city,
        room.swamp,
        room.players,
        room.revealKing
      );
      room.map.generate();

      console.log(`Start game with random map `);
    }
    room.mapGenerated = true;
    room.globalMapDiff = new MapDiff();
    room.gameRecord = new GameRecord(room.players, room.map.width, room.map.height);

    // Now: Client can get map name / width / height !
    // todo 对于自定义地图，地图名称应该在游戏开始前获知，而不是开始时
    console.info(`Start game`);
    room.gameStarted = true;
    let intro_message = 'Chat is being recorded.';
    room.gameRecord.addMessage({ turn: room.map.turn, player: null, content: intro_message });
    io.in(room.id).emit('update_room', room);
    io.in(room.id).emit('room_message', null, intro_message);
    room.players.forEach((player) => {
      let player_socket = io.sockets.sockets.get(player.socket_id);
      if (player_socket) {
        let initGameInfo: initGameInfo = {
          king: player.king ? { x: player.king.x, y: player.king.y } : { x: 0, y: 0 }, // spectator's king is null
          mapWidth: room.map.width,
          mapHeight: room.map.height,
        };
        player_socket.emit('game_started', initGameInfo);
        player.patchView = new MapDiff();
      }
    });

    let updTime = 500 / room.gameSpeed;
    room.gameLoop = setInterval(async () => {
      try {
        room.players.forEach((player) => {
          if (!room.map) throw new Error('king is null');
          if (!player.isDead && !player.spectating() && !player.disconnected) {
            let block = room.map.getBlock(player.king);
            let blockPlayerIndex = getPlayerIndex(room, block.player?.id);
            if (blockPlayerIndex !== -1) {
              if (block.player !== player && player.isDead === false) {
                console.log(block.player.username, 'captured', player.username);
                io.in(room.id).emit('captured', block.player.minify(), player.minify());
                let player_socket = io.sockets.sockets.get(player.socket_id);
                if (player_socket) {
                  player_socket.emit('game_over', block.player.minify()); // captured by block.player
                } else {
                  throw new Error('socket is null');
                }
                player.isDead = true;
                player.land.forEach((block) => {
                  room.map.transferBlock(block, room.players[blockPlayerIndex]);
                  room.players[blockPlayerIndex].winLand(block);
                });
                room.map.getBlock(player.king).kingBeDominated();
                player.land.length = 0;
              } else if (player.operatedTurn === 0 && player.operatedTurn + 160 <= room.map.turn) {
                // if player is not operated for 160/2 turns, it will be neutralized
                handleNeutralized(room, player);
                io.in(room.id).emit('room_message', player.minify(), 'surrendered');
              }
            }
          }
        });

        let leaderBoardData: LeaderBoardTable = room.players
          .filter((player) => !player.spectating())
          .map((player) => {
            let data = room.map.getTotal(player);
            return [player.color, player.team, data.army, data.land] as LeaderBoardRow;
          });

        let room_sockets = await io.in(room.id).fetchSockets();

        for (let socket of room_sockets) {
          let playerIndex = getPlayerIndexBySocket(room, socket.id);
          if (playerIndex !== -1 && room.players[playerIndex].patchView && !room.players[playerIndex].disconnected) {
            if (
              (room.deathSpectator && room.players[playerIndex].isDead) ||
              !room.fogOfWar ||
              room.players[playerIndex].spectating()
            ) {
              await room.players[playerIndex].patchView.patch(room.map.map);
            } else {
              await room.players[playerIndex].patchView.patch(await room.map.getViewPlayer(room.players[playerIndex]));
            }
            socket.emit('game_update', room.players[playerIndex].patchView.data, room.map.turn, leaderBoardData);
          }
        }

        await room.globalMapDiff.patch(room.map.map);
        room.gameRecord.addGameUpdate(room.globalMapDiff.data, room.map.turn, leaderBoardData);
        room.map.updateTurn();
        room.map.updateUnit();

        let aliveTeams = [];
        for (let player of room.players) {
          if (!player.isDead && !player.spectating() && !aliveTeams.includes(player.team)) {
            aliveTeams.push(player.team);
          }
        }
        // Game over, Find Winner
        if (aliveTeams.length <= 1) {
          if (!aliveTeams.length) return;
          let link = room.gameRecord.outPutToJSON(process.cwd());
          // 回放落盘后同步写入索引，供 GET /replays 检索；索引失败只记日志，不能影响对局结算
          void indexReplay(prisma, {
            replayId: link,
            playedAt: new Date(),
            players: room.gameRecord.players.map((player) => player.username),
            mapWidth: room.gameRecord.mapWidth,
            mapHeight: room.gameRecord.mapHeight,
          }).catch((error) => console.error('Failed to index replay:', link, error));
          io.in(room.id).emit(
            'game_ended',
            room.players.filter((x) => x.team === aliveTeams[0]).map((x) => x.minify(true)),
            link
          ); // winner
          console.log('Game ended, replay link: ', link);

          room.gameStarted = false;
          room.forceStartNum = 0;
          io.in(room.id).emit('update_room', room);

          room.players.forEach((player) => {
            player.reset();
          });

          room.players = room.players.filter((p) => !p.disconnected);
          clearInterval(room.gameLoop);
        }
      } catch (e: any) {
        console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
        console.log(e.stack);
      }
    }, updTime);
  }
}

function reject_join(socket: Socket, msg: string) {
  socket.emit('reject_join', msg);
  socket.disconnect();
}

function get_query_param(params: any, key: string) {
  if (Array.isArray(params[key])) {
    return params[key][0];
  } else {
    return params[key];
  }
}

// =====================
// main
// =====================

io.on('connection', async (socket) => {
  // ====================================
  // init
  // ====================================
  let room: Room;
  let player: Player;

  console.log(`new ${socket.id} connected`);

  let params = socket.handshake.query;

  let username = get_query_param(params, 'username');
  let roomId = get_query_param(params, 'roomId');
  let myPlayerId = get_query_param(params, 'myPlayerId');

  console.log(`new connect: ${username} ${roomId} ${myPlayerId}`);

  // validate roomId and username
  if (!roomId) {
    reject_join(socket, `roomId: ${username} is invalid`);
    return;
  }
  username = xss(username);
  if (!username.length) {
    username = 'Anonymous';
  }
  if (!roomPool[roomId]) {
    try {
      await createRoom(roomId);
    } catch (e: any) {
      reject_join(socket, e.message);
      console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
      console.log(e.stack);
    }
    // return;
  }
  room = roomPool[roomId];
  // check room status
  if (room.players.length >= room.maxPlayers) {
    reject_join(socket, 'The room is full.');
    return;
  } else {
    socket.join(roomId as string);
  }

  let isValidReconnectPlayer = false;

  if (myPlayerId) {
    // reconnect or same user with multiple tabs
    // todo: unfinished 因为玩家 disconnect 后，对应的 id会被清空，需要区分正常退出（清除id）和异常退出（保留玩家id）的情况
    let playerIndex = getPlayerIndex(room, myPlayerId);

    if (playerIndex !== -1) {
      isValidReconnectPlayer = true;
      room.players = room.players.filter((p) => p !== player);
      player = room.players[playerIndex];
      player.disconnected = false;
      room.players[playerIndex].socket_id = socket.id;
      io.in(room.id).emit('room_message', player.minify(), 're-joined the lobby.');
      io.in(room.id).emit('update_room', room);
    }
  }

  if (!isValidReconnectPlayer) {
    let playerId = crypto
      .randomBytes(Math.ceil(10 / 2))
      .toString('hex')
      .slice(0, 10);
    let allColor = Array.from({ length: ColorArr.length }, (_, i) => i);
    let occupiedColor = room.players.map((player) => player.color);
    occupiedColor.push(0); // 0 is reserved for neutral block
    let availableColor = allColor.filter((color) => {
      return !occupiedColor.includes(color);
    });
    let playerColor = availableColor[0];

    let allTeam = Array.from({ length: MaxTeamNum }, (_, i) => i + 1);
    let occupiedTeam = room.players.map((player) => player.team);
    let availableTeam = allTeam.filter((team) => {
      return !occupiedTeam.includes(team);
    });
    let playerTeam = availableTeam[0];

    // 自动识别机器人：如果用户名包含"bot"字样，则标记为机器人
    const isBot = username.toLowerCase().includes('bot');

    player = new Player(playerId, socket.id, username, playerColor, playerTeam, false, false, false, 0, [], null, null, false, isBot);
    console.log(`Connect! Socket ${socket.id}, room ${roomId} name ${username} playerId ${playerId} color ${playerColor} isBot: ${isBot}`);

    if (room.players.length === 0) {
      player.setRoomHost(true);
    }
    socket.emit('set_player_id', player.id);

    let message = 'joined the room.';

    if (room.gameStarted) {
      player.setSpectate();
      let initGameInfo: initGameInfo = {
        king: { x: 0, y: 0 }, // spectator's king is null
        mapWidth: room.map.width,
        mapHeight: room.map.height,
      };
      socket.emit('game_started', initGameInfo);
      player.patchView = new MapDiff();
      message = 'joined as spectator.';
    }

    room.players.push(player);

    // broadcast new player message to room
    io.in(room.id).emit('room_message', player.minify(), message);
    io.in(room.id).emit('update_room', room);
    console.log(player.username, message);

    // if (room.players.length >= room.maxPlayers) {
    //   await handleGame(room, io);
    // }
  }

  // ====================================
  // set up socket event listeners
  // ====================================

  socket.on('get_room_info', async () => {
    socket.emit('update_room', room);
  });

  socket.on('set_team', async (team) => {
    if ((team as number) <= 0 || (team as number) > MaxTeamNum + 1) {
      socket.emit('error', 'Unable to change team', `Team must be between 1 and ${MaxTeamNum} or spectators`);
      return;
    }
    player.team = team as number;

    if (player.spectating()) {
      // set spectate will cancel force start
      let playerIndex = getPlayerIndex(room, player.id);
      if (room.players[playerIndex].forceStart === true) {
        room.players[playerIndex].forceStart = false;
        --room.forceStartNum;
      }
    }
    io.in(room.id).emit('update_room', room);
    io.in(room.id).emit('room_message', player.minify(), player.spectating() ? 'became a spectator.' : `change to team ${team}.`);
    checkForcedStart(room, io);
  });

  socket.on('surrender', async (playerId) => {
    let playerIndex = getPlayerIndex(room, playerId);
    if (playerIndex === -1) {
      socket.emit('error', 'Surrender failed', 'Player not found.');
      return;
    }
    player = room.players[playerIndex];

    console.log(`${player.username} surrendered.`);

    if (!room.map) {
      socket.emit('error', 'Surrender failed', 'Map not found.');
      console.log('Error! Map not found.');
      return;
    }

    await handleNeutralized(room, player);

    io.in(room.id).emit('room_message', player.minify(), 'surrendered');
  });

  socket.on('change_host', async (playerId) => {
    try {
      if (!player.isRoomHost) {
        throw new Error('You are not the room host.');
      }
      let currentHost = getPlayerIndex(room, player.id);
      let newHost = getPlayerIndex(room, playerId);
      if (newHost !== -1) {
        room.players[currentHost].setRoomHost(false);
        room.players[newHost].setRoomHost(true);
        io.in(room.id).emit('update_room', room);
        io.in(room.id).emit('host_modification', player.minify(), room.players[newHost]);
      } else {
        throw new Error('Target player not found.');
      }
    } catch (e: any) {
      socket.emit('error', 'Host modification failed', e.message);
    }
  });

  socket.on('change_room_setting', async (property: string, value: number | string | boolean) => {
    try {
      if (player.isRoomHost) {
        console.log('Changing Room Setting ', property, value);
        if (property in room && value !== undefined) {
          // todo: move validation to Room class
          switch (property) {
            case 'roomName':
              if (typeof value !== 'string' || value.length > 20) {
                socket.emit('error', 'Modification was failed', 'Room name is too long.');
                return;
              }
              break;
            case 'mapId':
              if (typeof value !== 'string' || value.length > 50) {
                socket.emit('error', 'Modification was failed', 'invalid MapId');
                return;
              }
              const map = await prisma.customMapData.findUnique({
                where: { id: value },
                select: { name: true },
              });
              room.mapName = map?.name || '';
              break;
            case 'maxPlayers':
              if (typeof value !== 'number' || value <= 1) {
                socket.emit('error', 'Modification was failed', 'Max player num is invalid.');
                return;
              }
              break;
            case 'gameSpeed':
              if (typeof value !== 'number' || ![0.5, 0.75, 1, 2, 3, 4].includes(value)) {
                socket.emit('error', 'Modification was failed', `Game speed: ${value} is invalid. typeof value ${typeof value}}`);
                return;
              }
              break;
            case 'mapWidth':
            case 'mapHeight':
            case 'mountain':
            case 'city':
            case 'swamp':
              if (typeof value !== 'number' || value < 0 || value > 1) {
                socket.emit('error', 'Modification was failed', `Map ${property} is invalid.`);
                return;
              }
              break;
            case 'fogOfWar':
            case 'revealKing':
            case 'warringStatesMode':
            case 'deathSpectator':
              if (typeof value !== 'boolean') {
                socket.emit('error', 'Modification was failed', 'Invalid value.');
                return;
              }
              break;
            default:
              break;
          }

          room[property] = value;
          io.in(room.id).emit('update_room', room);
          if (property === 'mapId') {
            io.in(room.id).emit('room_message', player.minify(), `changed mapName to ${room.mapName}.`);
          } else {
            io.in(room.id).emit('room_message', player.minify(), `changed ${property} to ${value}.`);
          }
        } else {
          socket.emit('error', 'Modification was failed', `Invalid property: ${property} or value: ${value}.`);
        }
      } else {
        socket.emit('error', 'Modification was failed', 'You are not the game host.');
      }
    } catch (e: any) {
      console.log(e.message);
    }
  });

  socket.on('player_message', async (message) => {
    if (room.gameStarted) {
      room.gameRecord.addMessage({ turn: room.map.turn, player: player.minify(), content: message });
    }
    io.in(room.id).emit('room_message', player.minify(), ': ' + message);
  });

  socket.on('disconnect', async () => {
    await handleDisconnectInRoom(room, player, io);
    socket.disconnect();
    checkForcedStart(room, io); // check if game can start
  });

  socket.on('force_start', async () => {
    try {
      // 检查是否所有人类都是观战者
      const allHumanSpectators = room.players.filter(p => !p.isBot).every(p => p.spectating());

      if (allHumanSpectators) {
        // 特殊开始模式：所有人类都是观战者，房主可以直接开始游戏
        if (player.isRoomHost) {
          console.log('=== 特殊开始模式 ===');
          console.log('所有人类都是观战者，房主直接开始游戏');
          await handleGame(room, io);
          return;
        } else {
          socket.emit('error', 'Force start failed', '只有房主可以在所有人类都是观战者时开始游戏');
          return;
        }
      }

      // 正常逻辑：切换准备状态
      let playerIndex = getPlayerIndex(room, player.id);
      if (!room.players[playerIndex].spectating()) {
        if (room.players[playerIndex].forceStart === true) {
          room.players[playerIndex].forceStart = false;
          // 只有非机器人玩家才影响强制开始计数
          if (!room.players[playerIndex].isBot) {
            --room.forceStartNum;
          }
        } else {
          room.players[playerIndex].forceStart = true;
          // 只有非机器人玩家才影响强制开始计数
          if (!room.players[playerIndex].isBot) {
            ++room.forceStartNum;
          }
        }
        io.in(room.id).emit('update_room', room);
      }

      checkForcedStart(room, io);
    } catch (e: any) {
      console.log(e.stack);
      console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
    }
  });

  socket.on('end_room_game', async (action: 'end_game' | 'leave_room') => {
    try {
      if (!player.isRoomHost) {
        socket.emit('error', 'End game failed', 'You are not the room host.');
        return;
      }

      if (action === 'end_game') {
        // 结束游戏但保留房间
        await endRoomGame(room, io, 'Game ended by host');
        socket.emit('room_message', player.minify(), 'ended the game.');
      } else if (action === 'leave_room') {
        // 结束游戏并删除房间
        await endRoomGame(room, io, 'Room closed by host');

        // 通知所有玩家房间被删除
        io.in(room.id).emit('room_deleted', 'Room has been closed by host');

        // 断开所有玩家的连接
        io.in(room.id).disconnectSockets(true);

        // 从房间池中删除房间（如果不是keepAlive房间）
        if (!room.keepAlive) {
          delete roomPool[room.id];
        }

        console.log(`Room ${room.id} closed by host ${player.username}`);
      }
    } catch (e: any) {
      socket.emit('error', 'End game failed', e.message);
      console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
      console.log(e.stack);
    }
  });

  socket.on('force_end', async () => {
    try {
      if (!player.isRoomHost) {
        socket.emit('error', 'Force stop failed', 'You are not the room host.');
        return;
      }

      if (!room.gameStarted) {
        socket.emit('error', 'Force stop failed', 'Game is not started.');
        return;
      }

      // 强制停止游戏
      await endRoomGame(room, io, 'Game force stopped by host');
      socket.emit('room_message', player.minify(), 'force stopped the game.');
      console.log(`Room ${room.id} game force stopped by host ${player.username}`);
    } catch (e: any) {
      socket.emit('error', 'Force stop failed', e.message);
      console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
      console.log(e.stack);
    }
  });

  socket.on('attack', async (from: Point, to: Point, isHalf: boolean) => {
    try {
      if (typeof isHalf !== 'boolean') {
        socket.emit('attack_failure', from, to, 'Invalid parameter type');
        return;
      }
      if (from.x < 0 || from.x >= room.map.width || from.y < 0 || from.y >= room.map.height) {
        socket.emit('attack_failure', from, to, 'Invalid starting point');
        return;
      }

      if (to.x < 0 || to.x >= room.map.width || to.y < 0 || to.y >= room.map.height) {
        socket.emit('attack_failure', from, to, 'Invalid ending point, out of map');
        return;
      }

      if (Math.abs(from.x - to.x) > 1 || Math.abs(from.y - to.y) > 1) {
        socket.emit('attack_failure', from, to, 'Invalid ending point, not adjacent');
        return;
      }

      let playerIndex = getPlayerIndexBySocket(room, socket.id);
      if (playerIndex !== -1) {
        let player = room.players[playerIndex];
        if (room.map && player.operatedTurn < room.map.turn && room.map.commendable(player, from, to)) {
          if (isHalf) {
            room.map.moveHalfMovableUnit(player, from, to);
          } else {
            room.map.moveAllMovableUnit(player, from, to);
          }

          room.players[playerIndex].operatedTurn = room.map.turn;
          socket.emit('attack_success', from, to, room.map.turn);
        } else {
          socket.emit(
            'attack_failure',
            from,
            to,
            `Invalid operation: ${player.operatedTurn} ${room.map.turn} ${room.map.commendable(player, from, to)}`
          );
        }
      }
    } catch (e: any) {
      console.log(e.stack);
      console.error(JSON.stringify(e, ['message', 'arguments', 'type', 'name']));
    }
  });
});