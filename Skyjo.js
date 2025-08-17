import React, { useMemo, useReducer, useState, useEffect } from "react";

/**
 * SKYJO – hotseat browser version
 * Single-file React component; no backend required.
 * TailwindCSS recommended but optional. Drop this into any React app and render <SkyjoApp />.
 *
 * Features
 * - 2–6 local players, custom names & target score
 * - Proper turn flow: draw from deck/discard, replace or discard+flip
 * - Start-of-round 2-card flip per player
 * - Column clears: three-of-a-kind in a column removes that column from play
 * - Round scoring & running totals; game ends at target score (default 100)
 * - Simple, clean UI designed for large single-player focus and quick hotseat pass-around
 *
 * Notes
 * - Deck composition approximates the real game but is parameterized for easy tweaking.
 * - Rules variant penalties for the closing player are not included by default.
 */

// ---------- Deck configuration ----------
// Real Skyjo has a specific distribution; we use a playable approximation by default.
// You can tune counts here to match your set exactly if you wish.
const DEFAULT_DISTRIBUTION: Record<number, number> = {
  [-2]: 10,
  [-1]: 14,
  0: 16,
  1: 16,
  2: 16,
  3: 16,
  4: 16,
  5: 16,
  6: 14,
  7: 12,
  8: 10,
  9: 9,
  10: 8,
  11: 7,
  12: 6,
};

const ROWS = 3;
const COLS = 4;

type Cell = {
  value: number;
  faceUp: boolean;
  removed?: boolean; // true if cleared by 3-in-a-column
};

type Player = {
  id: number;
  name: string;
  grid: Cell[][]; // [row][col]
  totalScore: number;
};

type GameState = {
  phase: "setup" | "initialFlip" | "turn" | "roundEnd" | "gameOver";
  players: Player[];
  currentPlayer: number; // index into players
  deck: number[];
  discard: number[];
  // initial flip state
  initialFlipPlayer: number; // who is currently doing their 2 flips
  flipsRemaining: number; // remaining flips for that player during initial flip phase

  // turn state
  drawnCard: number | null; // current player's drawn card (if any)
  closingIndex: number | null; // if someone has revealed all cards, store their index to detect final cycle
  targetScore: number;
  roundNumber: number;
};

// ---------- Helpers ----------
function makeDeck(distribution: Record<number, number>): number[] {
  const deck: number[] = [];
  for (const [numStr, count] of Object.entries(distribution)) {
    const n = Number(numStr);
    for (let i = 0; i < count; i++) deck.push(n);
  }
  // shuffle (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealGrid(deck: number[]): { grid: Cell[][]; deck: number[] } {
  const newDeck = [...deck];
  const grid: Cell[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      const value = newDeck.pop();
      if (value === undefined) throw new Error("Deck ran out during deal.");
      row.push({ value, faceUp: false, removed: false });
    }
    grid.push(row);
  }
  return { grid, deck: newDeck };
}

function countFaceDown(grid: Cell[][]): number {
  let count = 0;
  grid.forEach((row) =>
    row.forEach((cell) => {
      if (!cell.faceUp && !cell.removed) count++;
    })
  );
  return count;
}

function allRevealedOrRemoved(grid: Cell[][]): boolean {
  return countFaceDown(grid) === 0;
}

function columnValues(grid: Cell[][], col: number): number[] {
  const vals: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cell = grid[r][col];
    if (!cell.removed && cell.faceUp) vals.push(cell.value);
    else return []; // if any is facedown/removed, can't clear
  }
  return vals;
}

function tryClearColumns(grid: Cell[][]): { changed: boolean; grid: Cell[][] } {
  const newGrid = grid.map((row) => row.map((cell) => ({ ...cell })));
  let changed = false;
  for (let c = 0; c < COLS; c++) {
    const vals = columnValues(newGrid, c);
    if (vals.length === ROWS && vals.every((v) => v === vals[0])) {
      // mark removed
      for (let r = 0; r < ROWS; r++) {
        newGrid[r][c].removed = true;
      }
      changed = true;
    }
  }
  return { changed, grid: newGrid };
}

function gridScore(grid: Cell[][]): number {
  let sum = 0;
  grid.forEach((row) =>
    row.forEach((cell) => {
      if (!cell.removed) sum += cell.faceUp ? cell.value : cell.value; // facedown still counts at end of round
    })
  );
  return sum;
}

function visibleGridScore(grid: Cell[][]): number {
  // Helper for UX (only counts face-up, non-removed)
  let sum = 0;
  grid.forEach((row) =>
    row.forEach((cell) => {
      if (!cell.removed && cell.faceUp) sum += cell.value;
    })
  );
  return sum;
}

// ---------- Reducer ----------

type Action =
  | { type: "SETUP_CREATE"; names: string[]; targetScore: number }
  | { type: "INITIAL_FLIP_CLICK"; row: number; col: number }
  | { type: "DRAW_FROM_DECK" }
  | { type: "DRAW_FROM_DISCARD" }
  | { type: "REPLACE_CELL"; row: number; col: number }
  | { type: "DISCARD_DRAWN" }
  | { type: "FLIP_AFTER_DISCARD"; row: number; col: number }
  | { type: "NEXT_PLAYER" }
  | { type: "START_NEXT_ROUND" };

function startRound(players: Player[], distribution = DEFAULT_DISTRIBUTION) {
  let deck = makeDeck(distribution);
  const discard: number[] = [];
  const newPlayers = players.map((p) => ({ ...p }));
  newPlayers.forEach((p) => {
    const dealt = dealGrid(deck);
    p.grid = dealt.grid;
    deck = dealt.deck;
  });
  // turn up the first discard
  discard.push(deck.pop() as number);
  return {
    players: newPlayers,
    deck,
    discard,
    phase: "initialFlip" as const,
    initialFlipPlayer: 0,
    flipsRemaining: 2,
    currentPlayer: 0,
    drawnCard: null,
    closingIndex: null,
  };
}

function rootReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "SETUP_CREATE": {
      const names = action.names.map((n) => n.trim()).filter(Boolean);
      const valid = names.slice(0, 6).filter((n) => n.length > 0);
      if (valid.length < 2) return state;
      const players: Player[] = valid.map((name, idx) => ({
        id: idx,
        name,
        grid: Array.from({ length: ROWS }, () =>
          Array.from({ length: COLS }, () => ({ value: 0, faceUp: false }))
        ),
        totalScore: 0,
      }));
      const round = startRound(players);
      return {
        ...state,
        ...round,
        targetScore: Math.max(30, Math.min(500, action.targetScore || 100)),
        roundNumber: 1,
      };
    }

    case "INITIAL_FLIP_CLICK": {
      if (state.phase !== "initialFlip") return state;
      const pIdx = state.initialFlipPlayer;
      const players = state.players.map((p) => ({ ...p, grid: p.grid.map((row) => row.map((c) => ({ ...c }))) }));
      const cell = players[pIdx].grid[action.row][action.col];
      if (cell.removed || cell.faceUp) return state;
      cell.faceUp = true;
      let flipsRemaining = state.flipsRemaining - 1;
      let initialFlipPlayer = state.initialFlipPlayer;
      let phase: GameState["phase"] = state.phase;
      if (flipsRemaining === 0) {
        // advance to next player or start turns
        if (pIdx === players.length - 1) {
          phase = "turn";
          initialFlipPlayer = 0;
          flipsRemaining = 0;
        } else {
          initialFlipPlayer = pIdx + 1;
          flipsRemaining = 2;
        }
      }
      return { ...state, players, flipsRemaining, initialFlipPlayer, phase };
    }

    case "DRAW_FROM_DECK": {
      if (state.phase !== "turn" || state.drawnCard !== null) return state;
      const deck = [...state.deck];
      if (deck.length === 0) return state; // edge: no draw
      const drawnCard = deck.pop() as number;
      return { ...state, deck, drawnCard };
    }

    case "DRAW_FROM_DISCARD": {
      if (state.phase !== "turn" || state.drawnCard !== null) return state;
      const discard = [...state.discard];
      if (discard.length === 0) return state;
      const drawnCard = discard.pop() as number;
      return { ...state, discard, drawnCard };
    }

    case "REPLACE_CELL": {
      if (state.phase !== "turn" || state.drawnCard === null) return state;
    
      const pIdx = state.currentPlayer;
      const players = state.players.map((p) => ({
        ...p,
        grid: p.grid.map((row) => row.map((c) => ({ ...c }))),
      }));
    
      const cell = players[pIdx].grid[action.row][action.col];
      if (cell.removed) return state;
    
      const discard = [...state.discard, cell.value];
      cell.value = state.drawnCard;
      cell.faceUp = true;
    
      const cleared = tryClearColumns(players[pIdx].grid);
      players[pIdx].grid = cleared.grid;
    
      let closingIndex = state.closingIndex;
      if (closingIndex === null && allRevealedOrRemoved(players[pIdx].grid)) {
        closingIndex = pIdx;
      }
    
      return {
        ...state,
        players,
        discard,
        drawnCard: null,
        closingIndex,
        justActed: true, // triggers useEffect for next player
        phase: "turn",
      };
    }

    case "DISCARD_DRAWN": {
      if (state.phase !== "turn" || state.drawnCard === null) return state;
      // drop the card onto discard; user must then flip any facedown cell
      const discard = [...state.discard, state.drawnCard];
      return { ...state, discard, drawnCard: null, phase: "flipAfterDiscard" };
    }

    case "FLIP_AFTER_DISCARD": {
      if (state.phase !== "flipAfterDiscard") return state;
    
      const pIdx = state.currentPlayer;
      const players = state.players.map((p) => ({
        ...p,
        grid: p.grid.map((row) => row.map((c) => ({ ...c }))),
      }));
    
      const cell = players[pIdx].grid[action.row][action.col];
      if (cell.removed || cell.faceUp) return state;
    
      cell.faceUp = true;
    
      const cleared = tryClearColumns(players[pIdx].grid);
      players[pIdx].grid = cleared.grid;
    
      let closingIndex = state.closingIndex;
      if (closingIndex === null && allRevealedOrRemoved(players[pIdx].grid)) {
        closingIndex = pIdx;
      }
    
      return {
        ...state,
        players,
        closingIndex,
        justActed: true, // triggers useEffect for next player
        phase: "turn",
      };
    }

    case "NEXT_PLAYER": {
      if (state.phase !== "turn") return state;
      // Advance turn; if closing player reached again, end round
      const num = state.players.length;
      const next = (state.currentPlayer + 1) % num;
      if (state.closingIndex !== null && next === state.closingIndex) {
        // End round and score
        const players = state.players.map((p) => ({ ...p }));
        players.forEach((p) => {
          p.totalScore += gridScore(p.grid);
        });
        // Check for game over
        const someoneReachedTarget = players.some((p) => p.totalScore >= state.targetScore);
        return {
          ...state,
          phase: someoneReachedTarget ? "gameOver" : "roundEnd",
          players,
        };
      }
      return { ...state, currentPlayer: next, justActed: false };
    }

    case "START_NEXT_ROUND": {
      if (state.phase !== "roundEnd") return state;
      const round = startRound(state.players);
      return {
        ...state,
        ...round,
        roundNumber: state.roundNumber + 1,
      };
    }

    default:
      return state;
  }
}

// ---------- UI Components ----------

function Pile({ label, top, onDraw, disabled }: { label: string; top?: number; onDraw?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onDraw}
      disabled={disabled}
      className={`flex flex-col items-center justify-center w-28 h-40 rounded-2xl border shadow p-2 transition active:scale-[0.98] ${
        disabled ? "opacity-50 cursor-not-allowed" : "hover:shadow-lg bg-white"
      }`}
      aria-label={label}
      title={label}
    >
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="text-4xl font-semibold select-none">{top ?? "?"}</div>
    </button>
  );
}

function CardView({ cell, highlight }: { cell: Cell; highlight?: boolean }) {
  let classes = "w-16 h-24 rounded-xl border flex items-center justify-center text-2xl font-semibold shadow-sm select-none";
  if (cell.removed) classes += " bg-transparent border-dashed opacity-30";
  else if (cell.faceUp) classes += " bg-white";
  else classes += " bg-slate-200";
  if (highlight) classes += " ring-4 ring-emerald-400";
  return <div className={classes}>{cell.removed ? "" : cell.faceUp ? cell.value : ""}</div>;
}

function Grid({ grid, onCellClick, highlightCells }: { grid: Cell[][]; onCellClick?: (r: number, c: number) => void; highlightCells?: boolean }) {
  return (
    <div className="grid grid-rows-3 grid-cols-4 gap-2">
      {grid.map((row, r) =>
        row.map((cell, c) => (
          <button
            key={`${r}-${c}`}
            onClick={() => onCellClick && onCellClick(r, c)}
            className="focus:outline-none"
          >
            <CardView cell={cell} highlight={!!highlightCells && !cell.faceUp && !cell.removed} />
          </button>
        ))
      )}
    </div>
  );
}

function PlayerChip({ name, active, score }: { name: string; active?: boolean; score: number }) {
  return (
    <div className={`px-3 py-2 rounded-2xl shadow flex items-center gap-2 ${active ? "bg-emerald-100" : "bg-white"}`}>
      <div className={`w-2 h-2 rounded-full ${active ? "bg-emerald-500" : "bg-slate-300"}`} />
      <div className="font-medium">{name}</div>
      <div className="text-sm opacity-70">{score} pts</div>
    </div>
  );
}

// ---------- Main App ----------
export default function SkyjoApp() {
  const [state, dispatch] = useReducer(rootReducer, {
    phase: "setup",
    players: [],
    currentPlayer: 0,
    deck: [],
    discard: [],
    initialFlipPlayer: 0,
    flipsRemaining: 2,
    drawnCard: null,
    closingIndex: null,
    targetScore: 100,
    roundNumber: 0,
  } as GameState);

  const [nameInputs, setNameInputs] = useState<string[]>(["Player 1", "Player 2"]);
  const [target, setTarget] = useState(100);

  const current = state.players[state.currentPlayer];
  const initialFlipP = state.players[state.initialFlipPlayer];

  const someoneLeads = useMemo(() => {
    if (!state.players.length) return null;
    return [...state.players].sort((a, b) => a.totalScore - b.totalScore)[0].id;
  }, [state.players]);
  useEffect(() => {
  if (state.justActed) {
    const timeout = setTimeout(() => {
      dispatch({ type: "NEXT_PLAYER" });
    }, 1000); // automatically go to next player after 1 second
    return () => clearTimeout(timeout);
  }
}, [state.justActed, dispatch]);
  

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-4 md:p-8">
      <div className="max-w-5xl mx-auto flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">Skyjo</h1>
          <div className="text-sm opacity-70">{state.phase !== "setup" && `Round ${state.roundNumber}`}</div>
        </header>

        {state.phase === "setup" && (
          <div className="bg-white rounded-3xl p-4 md:p-6 shadow">
            <h2 className="text-xl font-semibold mb-4">New Game</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Players (2–6)</label>
                <div className="flex flex-col gap-2 mt-2">
                  {nameInputs.map((name, idx) => (
                    <input
                      key={idx}
                      className="border rounded-xl p-2"
                      value={name}
                      onChange={(e) => {
                        const copy = [...nameInputs];
                        copy[idx] = e.target.value;
                        setNameInputs(copy);
                      }}
                    />
                  ))}
                  <div className="flex gap-2">
                    <button
                      className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200"
                      onClick={() => nameInputs.length < 6 && setNameInputs((x) => [...x, `Player ${x.length + 1}`])}
                    >
                      + Add player
                    </button>
                    <button
                      className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200"
                      onClick={() => nameInputs.length > 2 && setNameInputs((x) => x.slice(0, -1))}
                    >
                      – Remove last
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Target score to end game</label>
                <input
                  type="number"
                  className="border rounded-xl p-2 mt-2 w-full"
                  min={30}
                  max={500}
                  value={target}
                  onChange={(e) => setTarget(parseInt(e.target.value || "100"))}
                />
                <p className="text-xs opacity-70 mt-2">Lowest total wins when any player reaches the target.</p>
              </div>
            </div>
            <div className="mt-6 flex gap-2">
              <button
                className="px-4 py-2 rounded-2xl bg-emerald-500 text-white hover:bg-emerald-600 shadow"
                onClick={() => dispatch({ type: "SETUP_CREATE", names: nameInputs, targetScore: target })}
              >
                Start
              </button>
            </div>
          </div>
        )}

        {state.phase !== "setup" && (
          <div className="flex flex-col gap-4">
            {/* Scoreboard */}
            <div className="flex gap-2 flex-wrap">
              {state.players.map((p, idx) => (
                <PlayerChip key={p.id} name={p.name} active={idx === state.currentPlayer && state.phase === "turn"} score={p.totalScore} />
              ))}
            </div>

            {/* Table area */}
            <div className="grid md:grid-cols-[1fr_auto_1fr] gap-4 items-start">
              {/* Left: discard/draw piles */}
              <div className="flex md:flex-col gap-3 justify-center">
                <Pile
                  label="Draw"
                  onDraw={() => dispatch({ type: "DRAW_FROM_DECK" })}
                  disabled={state.phase !== "turn" || state.drawnCard !== null}
                />
                <Pile
                  label="Discard"
                  top={state.discard[state.discard.length - 1]}
                  onDraw={() => dispatch({ type: "DRAW_FROM_DISCARD" })}
                  disabled={state.phase !== "turn" || state.drawnCard !== null || state.discard.length === 0}
                />
              </div>

              {/* Center: current or initial flip player grid */}
              <div className="bg-white rounded-3xl shadow p-4">
                {state.phase === "initialFlip" && initialFlipP && (
                  <div className="flex flex-col items-center gap-3">
                    <div className="text-sm opacity-70">Initial flips – {initialFlipP.name}</div>
                    <Grid
                      grid={initialFlipP.grid}
                      onCellClick={(r, c) => dispatch({ type: "INITIAL_FLIP_CLICK", row: r, col: c })}
                      highlightCells
                    />
                    <div className="text-xs opacity-60">Flip {state.flipsRemaining} more card{state.flipsRemaining === 1 ? "" : "s"}.</div>
                  </div>
                )}

                {(state.phase === "turn"|| state.phase === "flipAfterDiscard" )&& current && (
                  <div className="flex flex-col items-center gap-4">
                    <div className="text-center">
                      <div className="text-sm opacity-70">Current player</div>
                      <div className="text-2xl font-semibold">{current.name}</div>
                      <div className="text-xs opacity-60">Face-up subtotal: {visibleGridScore(current.grid)} pts</div>
                      {state.closingIndex !== null && (
                        <div className="text-xs mt-1 px-2 py-1 rounded bg-amber-100 text-amber-800 inline-block">Final cycle in progress</div>
                      )}
                    </div>

                    <Grid
                      grid={current.grid}
                      onCellClick={(r, c) => {
                        // If a card is currently drawn, clicking replaces.
                        if (state.drawnCard !== null) {
                          dispatch({ type: "REPLACE_CELL", row: r, col: c });
                        }else if (state.phase === "flipAfterDiscard") {
                          dispatch({ type: "FLIP_AFTER_DISCARD", row: r, col: c });
                        } else {
                          // If no card drawn, allow flipping (discard first is required by rules but we allow flipping only after DISCARD_DRAWN)
                          // We restrict flips-after-discard by phase of UX: flip button below appears only after discarding a drawn card.
                        }
                      }}
                    />

                    {/* Action row */}
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button
                        className="px-3 py-2 rounded-xl bg-emerald-500 text-white disabled:opacity-50"
                        disabled={state.drawnCard !== null || state.phase !== "turn"}
                        onClick={() => dispatch({ type: "DRAW_FROM_DECK" })}
                      >
                        Draw from deck
                      </button>
                      <button
                        className="px-3 py-2 rounded-xl bg-blue-600 text-white disabled:opacity-50"
                        disabled={state.drawnCard !== null || state.phase !== "turn" || state.discard.length === 0}
                        onClick={() => dispatch({ type: "DRAW_FROM_DISCARD" })}
                      >
                        Take discard
                      </button>
                      {state.drawnCard !== null && (
                        <div className="px-3 py-2 rounded-xl bg-slate-100">
                          Drawn: <span className="font-semibold">{state.drawnCard}</span>
                        </div>
                      )}
                      {state.drawnCard !== null && (
                        <button
                          className="px-3 py-2 rounded-xl bg-slate-700 text-white"
                          onClick={() => dispatch({ type: "DISCARD_DRAWN" })}
                        >
                          Discard it (then flip)
                        </button>
                      )}
                    </div>

                    {/* Flip hint */}
                    {state.drawnCard === null && (
                      <div className="text-xs opacity-60">Tip: To replace, draw a card first. To flip instead, draw then discard, then click any facedown card.</div>
                    )}

                    {/* After discard, allow a face-down flip */}
                    <div className="text-center">
                      <button
                        className="mt-2 px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300"
                        onClick={() => { /* noop – instruction only */ }}
                        disabled
                        title="After discarding a drawn card, click a facedown card above to flip it."
                      >
                        After discarding, click a facedown card to flip
                      </button>
                    </div>

                    <div className="flex justify-center">
                      <button
                        className="px-4 py-2 rounded-2xl bg-slate-900 text-white disabled:opacity-40"
                        disabled={state.phase !== "turn"}
                        onClick={() => dispatch({ type: "NEXT_PLAYER" })}
                      >
                        End turn
                      </button>
                    </div>
                  </div>
                )}

                {state.phase === "roundEnd" && (
                  <div className="text-center">
                    <h3 className="text-xl font-semibold mb-2">Round finished</h3>
                    <table className="mx-auto text-left">
                      <thead>
                        <tr className="opacity-60 text-sm">
                          <th className="px-3 py-1">Player</th>
                          <th className="px-3 py-1">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.players.map((p) => (
                          <tr key={p.id} className="">
                            <td className="px-3 py-1">{p.name}</td>
                            <td className="px-3 py-1 font-semibold">{p.totalScore}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      className="mt-4 px-4 py-2 rounded-2xl bg-emerald-500 text-white"
                      onClick={() => dispatch({ type: "START_NEXT_ROUND" })}
                    >
                      Start next round
                    </button>
                  </div>
                )}

                {state.phase === "gameOver" && (
                  <div className="text-center">
                    <h3 className="text-xl font-semibold mb-2">Game over</h3>
                    <p className="mb-2">Target reached: {state.targetScore} points</p>
                    <div className="space-y-1">
                      {[...state.players]
                        .sort((a, b) => a.totalScore - b.totalScore)
                        .map((p, idx) => (
                          <div key={p.id} className={`font-medium ${idx === 0 ? "text-emerald-700" : ""}`}>
                            {idx + 1}. {p.name} — {p.totalScore} pts
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right: player list/turn order */}
              <div className="bg-white rounded-3xl p-4 shadow">
                <div className="text-sm font-semibold mb-2">Turn order</div>
                <ol className="space-y-1">
                  {state.players.map((p, idx) => (
                    <li key={p.id} className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${idx === state.currentPlayer && state.phase === "turn" ? "bg-emerald-500" : "bg-slate-300"}`} />
                        <span className={`font-medium ${idx === someoneLeads ? "text-emerald-700" : ""}`}>{p.name}</span>
                      </span>
                      <span className="text-sm opacity-70">{p.totalScore}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        )}

        <footer className="text-xs opacity-60 text-center mt-6">
          <p>Made with ❤️ for the browser. This is a fan-made implementation for learning/playtesting purposes.</p>
        </footer>
      </div>
    </div>
  );
}
