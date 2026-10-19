# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gennia is a real-time multiplayer strategy game server and client, inspired by generals.io. The goal is to capture enemy generals without losing your own. It's built as a monorepo with:
- **Client**: Next.js 13 with React, TypeScript, Socket.io-client, Material-UI
- **Server**: Express + Socket.io with TypeScript, Prisma + PostgreSQL

## Repository Structure

```
├── client/          # Next.js frontend application
│   ├── pages/       # Next.js pages (_app.tsx, index.tsx, rooms/[roomId].tsx, etc.)
│   ├── components/  # React components (GameRoom, GameMap, MapEditor, Lobby, etc.)
│   └── public/      # Static assets
├── server/          # Express + Socket.io backend
│   ├── src/
│   │   ├── server.ts        # Main server entry point with Socket.io handlers
│   │   └── lib/             # Core game logic
│   │       ├── map.ts       # GameMap class - map generation and game logic
│   │       ├── player.ts    # Player class
│   │       ├── block.ts     # Block/Tile class
│   │       ├── room-pool.ts # Room management
│   │       ├── types.ts     # Shared type definitions
│   │       ├── map-diff.ts  # MapDiff for efficient updates
│   │       └── game-record.ts # Game replay recording
│   └── prisma/
│       └── schema.prisma    # Database schema for custom maps
└── Makefile         # Deployment and setup commands
```

## Development Setup

### Client (Next.js)
```bash
cd client/
pnpm install
pnpm run dev          # Start dev server on http://localhost:3000
pnpm run build        # Production build
pnpm run lint         # Run ESLint
pnpm run format       # Check formatting with Prettier
pnpm run format:fix   # Fix formatting issues
```

### Server (Express + Socket.io)
```bash
cd server/
pnpm install
pnpm run dev          # Start dev server with nodemon
pnpm run build        # Compile TypeScript
pnpm start            # Run compiled JavaScript
pnpm run generate     # Generate Prisma client
```

### Database (PostgreSQL + Prisma)
- Copy `.env.example` to `.env` and configure `DATABASE_URL`
- Start PostgreSQL: `docker-compose up -d` (in server directory)
- Database commands:
  ```bash
  npx prisma generate        # Generate Prisma client after schema changes
  npx prisma migrate dev     # Run migrations
  pnpm dlx prisma studio     # Open database UI
  ```

### Deployment
```bash
make install           # Install dependencies for both client and server
make deploy            # Full deployment (build, start with PM2)
make restart           # Restart services after changes
```

## Architecture

### Real-time Game Flow

1. **Room System**: Players connect via Socket.io to a specific room (`roomPool` in `room-pool.ts`)
2. **Game Loop**: When game starts, `handleGame()` creates a `setInterval` loop that:
   - Updates game state every turn (interval based on `room.gameSpeed`)
   - Checks win conditions (king captured)
   - Sends incremental updates to each player using `MapDiff` patches
3. **Fog of War**: Each player receives a filtered view via `room.map.getViewPlayer(player)`
4. **Attack System**: Players send `attack` events with `from`/`to` positions; server validates and applies moves

### Key Classes & Concepts

- **Room** (`types.ts`): Contains game state, players, map, settings (fogOfWar, gameSpeed, etc.)
- **GameMap** (`map.ts`): Core game logic - map generation, unit movement, turn updates
- **Player** (`player.ts`): Player state, land ownership, king position
- **Block** (`block.ts`): Individual map tile with type (King/City/Plain/Mountain/Swamp), owner, units
- **MapDiff** (`map-diff.ts`): Efficient patch-based updates to minimize data sent over socket
- **GameRecord** (`game-record.ts`): Records all game updates for replay functionality

### Socket.io Events (server.ts)

**Client → Server**:
- `get_room_info`: Request room state
- `set_team`: Change player team
- `force_start`: Vote to start game
- `attack`: Send attack command (from, to, isHalf)
- `surrender`: Give up and neutralize all land
- `change_room_setting`: Modify game settings (host only)
- `player_message`: Send chat message

**Server → Client**:
- `update_room`: Broadcast room state changes
- `game_started`: Game begins, send initial map info
- `game_update`: Incremental map updates each turn (MapDiffData)
- `game_ended`: Game over, send winners and replay link
- `captured`: Broadcast when a player's general is captured
- `room_message`: Chat messages

### Database Schema

Two models in Prisma:
- **CustomMapData**: User-created maps with `mapTilesData` (JSON string), views, starCount
- **StarUsers**: Junction table for user favorites (userId, mapId)

### API Endpoints (server.ts)

- `GET /ping`: Health check
- `GET /get_rooms`: List all active rooms
- `GET /create_room`: Create new room
- `GET /get_replay/:replayId`: Fetch replay JSON
- `GET /maps`, `POST /maps`, `GET /maps/:id`, `PUT /maps/:id`, `DELETE /maps/:id`: CRUD for custom maps
- `GET /new`, `GET /best`, `GET /hot`: Get maps sorted by recency, stars, views
- `GET /search?q=`: Search maps by name or ID
- `POST /toggleStar`: Star/unstar a map
- `GET /starredMaps?userId=`: Get user's starred maps

## Testing & Building

- **Client tests**: Not currently configured
- **Server tests**: Not currently configured
- **Type checking**: Run `pnpm run build` in both client and server to check TypeScript errors
- **Linting**: `pnpm run lint` in client directory

## Special Notes

- **PM2 for production**: Uses PM2 process manager for deployment (see Makefile)
- **China installation**: Use `make install_in_china` to configure npm mirrors for China
- **Replay system**: Games are recorded as JSON files in `server/records/` directory
- **Pre-configured rooms**: `roomPool` has default rooms ('1' for bots, 'warring_state' for special mode)
- **Force start mechanism**: Players vote to start; when threshold reached (`forceStartOK`), game begins
- **Team system**: Supports multiple teams (MaxTeamNum), players on same team share victory
- **Map generation**: Random maps generated based on room settings (mapWidth, mapHeight, mountain, city density) or custom maps loaded from database
- **Domain**: Current production domain is generals.gxwtf.cn
