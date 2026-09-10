#!/usr/bin/env node
/**
 * The Slow Table Chess Club — the tool the pages promise.
 *
 * `chess.ts` answers one question: *is this a position chess allows?* `chess-club.ts` reads a game
 * file and keeps the ratings. This file is only the keyboard.
 *
 * It does not evaluate, score, rank or suggest anything, and there is no evaluation function in
 * any of the three files. Legality is not strength; verifying that a board is real is a different
 * act from being told what to play on it, and the club draws its line exactly there. The reasoning
 * is set out in ../CLUB.md, under "Why the engine exists, since it looks like a contradiction".
 *
 * Requirements: Node >= 22. No dependencies, no install, no package.json — Node 22 runs TypeScript
 * directly. If `node --version` says 22 or more, everything below works from a fresh clone.
 *
 *   node tools/cli.ts validate                 # replay every game in games/ from move 1
 *   node tools/cli.ts validate <game>          # just one
 *   node tools/cli.ts show <game>              # current position, ASCII board + FEN
 *   node tools/cli.ts rate                     # recompute the whole rating table
 *   node tools/cli.ts render                   # rewrite standings.md
 *   node tools/cli.ts add-move <game> <move> [--letter <ref>]
 *
 * `<game>` takes a path, or just the file name under `games/`.
 *
 * `add-move` is the only command with teeth: it replays the entire game before writing, and
 * refuses an illegal move instead of recording it. That is the whole point. A game played by
 * letters has no shared board, so nothing else catches an impossible move — it happened at this
 * table three times, and nobody noticed for days.
 *
 * Exit code is 0 when everything replays, 1 when a game is broken or a move is refused. Useful in
 * a hook: `node tools/cli.ts validate` before you publish a record.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { replay, toFen, renderBoard } from "./chess.ts";
import { addMove, checkGame, isProvisional, parseGame, rate, renderStandings, type Game } from "./chess-club.ts";

/** The club directory is the parent of `tools/`. */
const CLUB = path.resolve(import.meta.dirname, "..");
const GAMES = path.join(CLUB, "games");

function load(file: string): Game {
  return parseGame(readFileSync(file, "utf8"), path.basename(file));
}

function resolveGame(arg: string): string {
  if (arg && existsSync(arg)) return arg;
  const inGames = path.join(GAMES, arg.endsWith(".md") ? arg : `${arg}.md`);
  if (existsSync(inGames)) return inGames;
  throw new Error(`no such game: "${arg}" (neither as a path, nor under ${GAMES})`);
}

function allGameFiles(): string[] {
  if (!existsSync(GAMES)) return [];
  return readdirSync(GAMES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(GAMES, f));
}

function report(g: Game): boolean {
  const c = checkGame(g);
  if (!c.ok) {
    console.error(`✗ ${g.name} — ILLEGAL move ${c.label}`);
    console.error(`  ${c.reason}`);
    console.error(`  position just before: ${c.fen}`);
    console.error(`  (${c.validated} half-moves replayed before the stop)`);
    return false;
  }
  const state = c.status === "ongoing" ? `in progress, ${c.toMove} to move` : c.status;
  console.log(`✓ ${g.name} — ${g.white} (white) vs ${g.black} (black), ${c.plies} half-moves, ${state}`);
  console.log(`  ${c.fen}`);
  return true;
}

function main(): number {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { letter: { type: "string", default: "" } },
  });
  const cmd = positionals[0];

  if (cmd === "validate") {
    const files = positionals[1] ? [resolveGame(positionals[1])] : allGameFiles();
    if (files.length === 0) {
      console.error(`no games under ${GAMES}`);
      return 1;
    }
    let bad = 0;
    for (const f of files) if (!report(load(f))) bad++;
    return bad === 0 ? 0 : 1;
  }

  if (cmd === "rate") {
    const { table, counted, ongoing } = rate(allGameFiles().map(load));
    console.log(`${counted} rated game(s), ${ongoing} in progress.`);
    for (const [i, s] of table.entries()) {
      const prov = isProvisional(s) ? " (provisional)" : "";
      console.log(`${String(i + 1).padStart(2)}. ${s.member.padEnd(20)} ${s.rating}${prov}  — ${s.played} rated, ${s.w}-${s.d}-${s.l}`);
    }
    return 0;
  }

  if (cmd === "render") {
    // No commit is passed: the page must not cite a revision its readers cannot look up.
    const out = renderStandings(allGameFiles().map(load), { date: new Date().toISOString().slice(0, 10) });
    const dest = path.join(CLUB, "standings.md");
    writeFileSync(dest, out);
    console.log(`written: ${dest}\n`);
    console.log(out);
    return 0;
  }

  if (cmd === "show") {
    const g = load(resolveGame(positionals[1] ?? ""));
    const r = replay(g.moves.map((m) => m.san));
    if (!r.ok) return report(g) ? 0 : 1;
    console.log(renderBoard(r.position));
    console.log(toFen(r.position));
    console.log(`to move: ${r.toMove === "w" ? g.white : g.black} (${r.toMove === "w" ? "white" : "black"})`);
    return 0;
  }

  if (cmd === "add-move") {
    if (!positionals[1] || !positionals[2]) {
      console.error("usage: cli.ts add-move <game> <move> [--letter <ref>]");
      return 1;
    }
    const file = resolveGame(positionals[1]);
    const r = addMove(load(file), positionals[2], values.letter ?? "");
    if (!r.ok) {
      console.error(`✗ REFUSED — ${r.reason}`);
      console.error(`  nothing was written. Position to move: ${r.fen}`);
      return 1;
    }
    writeFileSync(file, r.lines.join("\n"));
    console.log(`✓ ${r.label} written to ${path.basename(file)}`);
    if (r.status !== "ongoing") console.log(`  ⚑ the game is ${r.status} — set result: and completed: by hand.`);
    console.log(`  ${r.fen}`);
    return 0;
  }

  console.error("commands: validate [<game>] | rate | render | show <game> | add-move <game> <move> [--letter <ref>]");
  return 1;
}

process.exit(main());
