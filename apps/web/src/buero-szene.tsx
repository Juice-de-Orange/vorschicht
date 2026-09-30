import type { DeskState } from '@vorschicht/shared/buero';
import {
  FENSTER,
  FIGUR,
  fensterPalette,
  figurPalette,
  kugelRects,
  MOEBEL,
  PALETTE,
  type PersonaLook,
  PFLANZE,
  PFLANZE_PALETTE,
  type PixelRect,
  SCHIRM,
  SZENE,
  schirmRects,
  spriteRects,
  UHR,
  UHR_PALETTE,
} from './buero-pixel.js';

/**
 * The room, drawn.
 *
 * Every decision that could be wrong without a browser noticing lives in
 * `./buero-pixel.ts` — the palette, the sprites, the rule that keeps §17.2's
 * five bubbles apart, all of it reachable by a node test because `apps/web` has
 * no DOM test environment. What is here is placement, and it is placement in
 * one specific order: **chair, person, desk, things on the desk.** A
 * half-perspective scene is nothing but its depth order; draw the desk before
 * the person and the person is sitting on the table.
 *
 * Everything in this file is `aria-hidden`. Not an oversight — the desk it sits
 * inside is a real `<button>` whose accessible name already carries the
 * colleague, the department, the state and the task, and a second telling of it
 * in an SVG `<title>` would make every desk announce itself twice. §22's Phase 7
 * puts an axe scan over this page, and decoration that declares itself as
 * decoration is what that scan is looking for.
 */

/**
 * One sprite's worth of `<rect>`s.
 *
 * The key is the geometry plus the colour rather than an array index: two runs
 * of the same colour never share a position, so it is stable across a re-render
 * that changes a bubble — and a bubble changing is the one thing this page does
 * often.
 */
function Rechtecke({ rects, id }: { rects: readonly PixelRect[]; id: string }) {
  return (
    <>
      {rects.map((r) => (
        <rect
          key={`${id}:${r.x}:${r.y}:${r.w}:${r.h}:${r.fill}`}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          style={{ fill: r.fill }}
        />
      ))}
    </>
  );
}

function Sprite({
  rows,
  palette,
  x,
  y,
  id,
}: {
  rows: readonly string[];
  palette: Record<string, string>;
  x: number;
  y: number;
  id: string;
}) {
  const rects = spriteRects(rows, palette).map((r) => ({ ...r, x: r.x + x, y: r.y + y }));
  return <Rechtecke rects={rects} id={id} />;
}

/** A plain block of furniture — a desk panel, a leg, a screen. */
function Block({ x, y, w, h, fill }: { x: number; y: number; w: number; h: number; fill: string }) {
  return <rect x={x} y={y} width={w} height={h} style={{ fill }} />;
}

export interface SzeneProps {
  /** Null draws the furniture and nobody at it — the Feierabend variant. */
  readonly state: DeskState | null;
  readonly look: PersonaLook | null;
  /** Distinguishes the rect keys of two scenes on one page. */
  readonly id: string;
}

/**
 * One desk: chair, colleague, desk, monitor, keyboard, mug, status bubble.
 *
 * `state === null` is the empty room's furniture. It is the *same* scene with
 * the person and the bubble left out and the screen dark, rather than a second
 * drawing — a Feierabend office that did not match the working one would be two
 * rooms, and the one the operator sees first would be the one nothing keeps honest.
 */
export function Szene({ state, look, id }: SzeneProps) {
  const stuhl = look ? MOEBEL.stuhl : MOEBEL.stuhlLeer;
  return (
    <svg
      className="px-szene"
      viewBox={`0 0 ${SZENE.breite} ${SZENE.hoehe}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* 1 — der Stuhl, ganz hinten. Besetzt ist er breit, weil eine Person
              davor sitzt und nur seine Ränder zu sehen sind; leer wäre das eine
              graue Fläche in Tischbreite, also steht er dann eingeschoben da. */}
      <Block {...stuhl} fill={PALETTE.stuhl} />
      <Block x={stuhl.x} y={stuhl.y} w={stuhl.w} h={1} fill={PALETTE.stuhlHell} />

      {/* 2 — die Person davor. Die letzte Sprite-Zeile sind die Hände, und sie
              endet genau eine Zeile über der Tischplatte: sie liegen auf. */}
      {look && (
        <Sprite
          rows={FIGUR}
          palette={figurPalette(look)}
          x={MOEBEL.figur.x}
          y={MOEBEL.figur.y}
          id={`${id}-figur`}
        />
      )}

      {/* 3 — der Tisch, vor der Person */}
      <Block {...MOEBEL.platteHell} fill={PALETTE.holzHell} />
      <Block {...MOEBEL.platte} fill={PALETTE.holz} />
      <Block {...MOEBEL.blende} fill={PALETTE.holz} />
      <Block {...MOEBEL.beinLinks} fill={PALETTE.holzDunkel} />
      <Block {...MOEBEL.beinRechts} fill={PALETTE.holzDunkel} />

      {/* 4 — was auf dem Tisch steht */}
      <Block {...MOEBEL.tastatur} fill={PALETTE.geraet} />
      <Block {...SCHIRM.rahmen} fill={PALETTE.geraet} />
      <Block
        {...SCHIRM.flaeche}
        fill={state === null || state === 'ruht' ? PALETTE.schirmAus : PALETTE.schirm}
      />
      <Rechtecke rects={schirmRects(state)} id={`${id}-schirm`} />
      <Block {...SCHIRM.fuss} fill={PALETTE.geraet} />
      <Block {...MOEBEL.tasse} fill={PALETTE.tasse} />
      <Block {...MOEBEL.henkel} fill={PALETTE.tasse} />

      {/* 5 — die Statusblase, über allem */}
      {state !== null && (
        <g transform={`translate(${MOEBEL.blase.x} ${MOEBEL.blase.y})`}>
          <Rechtecke rects={kugelRects(state)} id={`${id}-blase`} />
        </g>
      )}
    </svg>
  );
}

/** Wall decoration. Three small things, so the room has a wall and not a band. */
export function Fenster({ abend }: { abend: boolean }) {
  return (
    <svg
      className="px-fenster"
      width={13}
      height={9}
      viewBox="0 0 13 9"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Sprite rows={FENSTER} palette={fensterPalette(abend)} x={0} y={0} id="fenster" />
    </svg>
  );
}

export function Uhr() {
  return (
    <svg
      className="px-uhr"
      width={9}
      height={8}
      viewBox="0 0 9 8"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Sprite rows={UHR} palette={UHR_PALETTE} x={0} y={0} id="uhr" />
    </svg>
  );
}

export function Pflanze() {
  return (
    <svg
      className="px-pflanze"
      width={9}
      height={8}
      viewBox="0 0 9 8"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <Sprite rows={PFLANZE} palette={PFLANZE_PALETTE} x={0} y={0} id="pflanze" />
    </svg>
  );
}
