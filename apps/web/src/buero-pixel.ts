/**
 * §17.2's office as an actual room — the pixel scene, in pure functions.
 *
 * §17.2 asks for "desks/avatars for every active persona … built as a
 * lightweight SVG/DOM scene (no heavy engine)", and the operator asked for it in one
 * sentence: **„verpixelter Office Style, gemütlich und gut leserlich."** What
 * was there answered the first half of the specification and none of the
 * second: five `<rect>`s, a coloured circle with an initial in it, and a card
 * list. This module is the drawing; `Buero.tsx` places it and decides nothing
 * about it.
 *
 * Same arrangement as `./buero-format.ts` and for the same reason: `apps/web`
 * has **no DOM test environment**, so anything that can be wrong without a
 * browser noticing has to live in a `.ts` file a node test can import. What is
 * here is exactly that — the sprite compiler, the palette, the per-persona
 * look, and the rule that keeps §17.2's five bubbles apart. What stays in the
 * component is markup.
 *
 * ---------------------------------------------------------------------------
 * SVG, not canvas — and the reason is the gate two doors down
 * ---------------------------------------------------------------------------
 *
 * §22's Phase 7 carries "axe scan on all pages: **zero** violations", and a
 * canvas is one opaque graphic to every assistive technology there is: the
 * click targets would have to be rebuilt as an invisible DOM layer, the
 * accessible names invented, focus order written by hand, and the result
 * checked by nothing. Inline SVG inside the buttons that already exist keeps
 * every one of those properties for free — the desk *is* a `<button>` with a
 * real accessible name, and the scene inside it is `aria-hidden` decoration
 * that says nothing a screen reader has not already been told in words.
 *
 * It is also the cheaper of the two here. A canvas would redraw the whole room
 * on every frame off `/events`; this scene is DOM, so React touches the one
 * desk whose bubble changed and nothing else — which is the property the
 * measured gate ("< 1s end-to-end") rests on.
 *
 * **Drawn, never loaded.** Every pixel below is a `<rect>`: no image files, no
 * licence question, no second request, and it stays sharp at any scale because
 * there is nothing to resample. `shape-rendering="crispEdges"` on the `<svg>`
 * is what keeps the edges hard — `image-rendering: pixelated` is the raster
 * equivalent and does nothing to vector art, which is worth writing down
 * because the CSS property is the one everybody reaches for first.
 *
 * ---------------------------------------------------------------------------
 * Colour never carries a fact
 * ---------------------------------------------------------------------------
 *
 * Every fill below is `var(--px-…, #hex)`, so the design system a parallel
 * strand is building can take any of them over without a line changing here,
 * and a checkout without it still draws a finished room. But the important
 * half is the other one: **none of these colours is load-bearing.** §17.2's
 * five states are told apart by the shape of the bubble, by the glyph inside
 * it and by the German word beside it, and `KUGELN` is written so that a test
 * can assert that mechanically — see `buero-pixel.test.ts`. Roughly one man in
 * twelve cannot use hue as a channel, and a room that answers "is everything
 * fine" only in colour answers it for nobody else.
 */
import type { DeskState } from '@vorschicht/shared/buero';
import { DESK_STATE_COLORS, DESK_STATES } from '@vorschicht/shared/buero';

// ---------------------------------------------------------------------------
// The sprite compiler
// ---------------------------------------------------------------------------

/** One drawn pixel run: an `<svg>` `<rect>` in sprite units. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fill: string;
}

/** The one character that draws nothing. Everything else must be in the palette. */
export const TRANSPARENT = '.';

/**
 * Turn rows of characters into as few rectangles as will do.
 *
 * Pixel art written as text is the only form of it a person can read in a diff,
 * and one `<rect>` per pixel is the only form of it a browser should not be
 * asked to hold: the room draws up to twenty-four desks (`BUERO_MAX_DESKS`), so
 * the difference between a naive emitter and this one is a few hundred nodes
 * against a few thousand. Merging is done in both directions — horizontal runs
 * first, then a run absorbed into the identical run directly above it — because
 * blocky art is mostly rectangles and the vertical pass is what collapses a
 * shirt or a desk panel into one node instead of six.
 *
 * **An unknown character throws** rather than drawing nothing. A typo in a
 * sprite is a hole in the picture, and a hole is exactly the kind of defect
 * that gets looked at, shrugged at and shipped; a thrown error is caught by the
 * test that walks every sprite in this file. Fail closed, as everywhere else in
 * this project.
 */
export function spriteRects(rows: readonly string[], palette: Record<string, string>): PixelRect[] {
  const out: PixelRect[] = [];
  /** Index into `out` of the run that ended on the previous row, by `x:w:fill`. */
  let above = new Map<string, number>();

  rows.forEach((row, y) => {
    const current = new Map<string, number>();
    let x = 0;
    while (x < row.length) {
      const char = row[x] ?? TRANSPARENT;
      let width = 1;
      while (row[x + width] === char) width += 1;

      if (char !== TRANSPARENT && char !== ' ') {
        const fill = palette[char];
        if (fill === undefined) {
          throw new Error(`Unbekanntes Sprite-Zeichen "${char}" in Zeile ${y} (Spalte ${x}).`);
        }
        const key = `${x}:${width}:${fill}`;
        const merged = above.get(key);
        if (merged !== undefined) {
          const rect = out[merged];
          if (rect) out[merged] = { ...rect, h: rect.h + 1 };
          current.set(key, merged);
        } else {
          current.set(key, out.length);
          out.push({ x, y, w: width, h: 1, fill });
        }
      }
      x += width;
    }
    above = current;
  });

  return out;
}

/** Are all rows the same length? A ragged sprite silently shifts everything below it. */
export function istRechteckig(rows: readonly string[]): boolean {
  return rows.every((row) => row.length === (rows[0]?.length ?? 0));
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

/**
 * Every colour in the room, as a custom property with the drawn value as its
 * fallback.
 *
 * The fallback is not a placeholder: a checkout in which nothing defines
 * `--px-*` draws the finished room, and the design system overrides whichever
 * of them it has an opinion about. Warm and low-contrast between the furniture,
 * high-contrast between the furniture and the ink — "gemütlich und gut
 * leserlich" is a contrast decision before it is a colour one.
 */
function px(name: string, fallback: string): string {
  return `var(--px-${name}, ${fallback})`;
}

export const PALETTE = {
  ink: px('ink', '#2a2331'),
  holzHell: px('holz-hell', '#cda071'),
  holz: px('holz', '#ac7c4f'),
  holzDunkel: px('holz-dunkel', '#7c5735'),
  stuhl: px('stuhl', '#5d6675'),
  stuhlHell: px('stuhl-hell', '#7b8593'),
  geraet: px('geraet', '#3b414e'),
  schirm: px('schirm', '#20293a'),
  schirmAus: px('schirm-aus', '#171d28'),
  schirmText: px('schirm-text', '#7fd6a5'),
  papier: px('papier', '#f6f1e6'),
  tasse: px('tasse', '#d4674c'),
  pflanze: px('pflanze', '#4f8f5a'),
  pflanzeDunkel: px('pflanze-dunkel', '#3a6d43'),
  topf: px('topf', '#b1653f'),
  himmel: px('himmel', '#a8d3ea'),
  abend: px('abend', '#f0b06a'),
  rahmen: px('rahmen', '#8a6a4a'),
  wand: px('wand', '#e8ded0'),
  metall: px('metall', '#9aa3b0'),
} as const;

/**
 * Skin, hair and shirt, from ranges rather than one look repeated eighteen
 * times.
 *
 * A room in which everybody is the same person is a room nobody reads as a
 * room. The three ranges are deliberately outside §17.2's five state colours —
 * a shirt that happened to be the amber of `blockiert` would put a meaningless
 * instance of a meaningful colour on the screen, which is how a colour stops
 * being a signal.
 */
export const HAUT = [
  px('haut-1', '#f0c4a0'),
  px('haut-2', '#d9a077'),
  px('haut-3', '#a9714c'),
  px('haut-4', '#7a4b30'),
] as const;

export const HAAR = [
  px('haar-1', '#3a2a20'),
  px('haar-2', '#6b4423'),
  px('haar-3', '#b8853f'),
  px('haar-4', '#8f3f2f'),
  px('haar-5', '#4a4f5c'),
  px('haar-6', '#2b2b2b'),
] as const;

export const HEMD = [
  px('hemd-1', '#4c7fa8'),
  px('hemd-2', '#6b8f6a'),
  px('hemd-3', '#9b6fa3'),
  px('hemd-4', '#c98a5a'),
  px('hemd-5', '#5f6b8c'),
  px('hemd-6', '#a56b6b'),
  px('hemd-7', '#4f9a91'),
] as const;

export interface PersonaLook {
  readonly haut: string;
  readonly haar: string;
  readonly hemd: string;
}

/**
 * The same colleague looks the same every time, and two colleagues rarely look
 * alike.
 *
 * Derived from the profile id rather than from the seat, so a desk keeps its
 * occupant's face across a park, a resume and three review rounds — a room in
 * which the person changes colour when the task does is a room that reports a
 * change nobody made. djb2, because the requirement is *stable and spread*, not
 * unpredictable; a cryptographic hash here would be a dependency and a slower
 * render for a property nothing needs.
 */
export function personaLook(profileId: string): PersonaLook {
  let hash = 5381;
  for (let i = 0; i < profileId.length; i += 1) {
    hash = ((hash << 5) + hash + profileId.charCodeAt(i)) >>> 0;
  }
  return {
    haut: HAUT[hash % HAUT.length] ?? HAUT[0],
    haar: HAAR[(hash >>> 4) % HAAR.length] ?? HAAR[0],
    hemd: HEMD[(hash >>> 9) % HEMD.length] ?? HEMD[0],
  };
}

// ---------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------

/**
 * One colleague at a desk, sixteen pixels across.
 *
 * `H` hair · `S` skin · `E` eye · `M` mouth · `T` shirt · `K` collar. The last
 * two rows are the sleeves and the hands, and the hands are the reason the
 * figure is drawn *before* the desk and not after: they end exactly on the row
 * above the desk's top edge, so they rest on the surface rather than floating
 * over it or vanishing behind it.
 */
export const FIGUR = [
  '....HHHHHHHH....',
  '...HHHHHHHHHH...',
  '...HSSSSSSSSH...',
  '...HSSESSESSH...',
  '...HSSSMMSSSH...',
  '....SSSSSSSS....',
  '......SSSS......',
  '..TTTTTTTTTTTT..',
  '.TTTTTKKKKTTTTT.',
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'SS.TTTTTTTTTT.SS',
] as const;

export function figurPalette(look: PersonaLook): Record<string, string> {
  return {
    H: look.haar,
    S: look.haut,
    E: PALETTE.ink,
    M: PALETTE.ink,
    T: look.hemd,
    K: PALETTE.papier,
  };
}

// ---------------------------------------------------------------------------
// §17.2's five bubbles, told apart without colour
// ---------------------------------------------------------------------------

/**
 * Three silhouettes, and they are a ladder rather than a decoration.
 *
 *   * `rund` — nothing is wanted from anyone.
 *   * `eckig` — work has stopped and somebody will have to look.
 *   * `dreieck` — a question is waiting for the operator.
 *
 * Read from across the room, the outline is the first thing that carries; the
 * glyph separates the three round ones; the German word beside the desk is the
 * one that is exact. Colour is the fourth channel and is never the only one.
 */
export type BlasenForm = 'rund' | 'eckig' | 'dreieck';

const BLASE_RUND = [
  '..RRRRRRRRR..',
  '.RBBBBBBBBBR.',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  '.RBBBBBBBBBR.',
  '..RRRBBRRRR..',
  '....RBBR.....',
  '.....RR......',
] as const;

const BLASE_ECKIG = [
  'RRRRRRRRRRRRR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RBBBBBBBBBBBR',
  'RRRRBBRRRRRRR',
  '...RBBR......',
  '....RR.......',
] as const;

/**
 * The triangle's tail is centred where the other two point left.
 *
 * The other two are speech and point at the person who is speaking. This one is
 * not speech — it is the sign on the door, and a warning triangle leaning
 * sideways reads as an arrow. Found by looking at the first render: it did.
 */
const BLASE_DREIECK = [
  '......R......',
  '.....RBR.....',
  '....RBBBR....',
  '...RBBBBBR...',
  '..RBBBBBBBR..',
  '.RBBBBBBBBBR.',
  'RBBBBBBBBBBBR',
  'RRRRRBBRRRRRR',
  '.....RBBR....',
  '......RR.....',
] as const;

export const BLASEN: Record<BlasenForm, readonly string[]> = {
  rund: BLASE_RUND,
  eckig: BLASE_ECKIG,
  dreieck: BLASE_DREIECK,
};

/** Where the 5×5 glyph sits inside each outline — the triangle has no room up top. */
const GLYPH_ANKER: Record<BlasenForm, { x: number; y: number }> = {
  rund: { x: 4, y: 1 },
  eckig: { x: 4, y: 1 },
  dreieck: { x: 4, y: 2 },
};

/**
 * Five glyphs, five silhouettes, nothing repeated.
 *
 * `Z` for a chair with nothing on it, a rising bar for work in progress, a lens
 * for work being judged, a padlock for work that cannot move, an exclamation
 * for a question that is waiting. Five pictures a person can name — which is
 * the test: a glyph nobody can describe is a glyph carrying no channel.
 */
const GLYPH_RUHT = ['GGGGG', '...G.', '..G..', '.G...', 'GGGGG'] as const;
const GLYPH_ARBEITET = ['....G', '....G', '..G.G', '..G.G', 'G.G.G'] as const;
const GLYPH_PRUEFT = ['.GGG.', 'G...G', 'G...G', '.GGG.', '...GG'] as const;
const GLYPH_BLOCKIERT = ['.GGG.', 'G...G', 'GGGGG', 'GGGGG', 'GGGGG'] as const;
/**
 * Three pixels wide, not one — and the first row is empty on purpose.
 *
 * This glyph is the only one that has to fit inside a triangle, which is
 * narrow at the top and wide at the bottom. A one-pixel stroke was legible in
 * the sprite and a thread on screen; starting a row lower buys the width to
 * draw it properly.
 */
const GLYPH_ESKALIERT = ['.....', '.GGG.', '.GGG.', '.....', '.GGG.'] as const;

/** The screen behind them — a fourth reading of the same fact, on the monitor. */
const SCHIRM_ARBEITET = ['GGG.GG.', 'G.GGG..', 'GGGG.GG', 'G.GG...', 'GG.GGG.'] as const;
const SCHIRM_PRUEFT = ['G.GGGG.', '.G.....', 'G.GGGG.', '.G.....', 'G.GGGG.'] as const;
const SCHIRM_BLOCKIERT = ['.......', '.GGGGG.', '.G...G.', '.GGGGG.', '.......'] as const;
const SCHIRM_ESKALIERT = ['..GGG..', '.....G.', '...GG..', '.......', '...G...'] as const;

export interface KugelBild {
  readonly form: BlasenForm;
  readonly glyph: readonly string[];
  /** What the monitor shows, or null for a screen that is off. */
  readonly schirm: readonly string[] | null;
  /** The outline's colour — the fourth channel, never the only one. */
  readonly farbe: string;
}

export const KUGELN: Record<DeskState, KugelBild> = {
  ruht: {
    form: 'rund',
    glyph: GLYPH_RUHT,
    // Off, deliberately: an idle desk is the one place in this room where an
    // absence is the clearest possible statement.
    schirm: null,
    farbe: DESK_STATE_COLORS.ruht,
  },
  arbeitet: {
    form: 'rund',
    glyph: GLYPH_ARBEITET,
    schirm: SCHIRM_ARBEITET,
    farbe: DESK_STATE_COLORS.arbeitet,
  },
  prueft: {
    form: 'rund',
    glyph: GLYPH_PRUEFT,
    schirm: SCHIRM_PRUEFT,
    farbe: DESK_STATE_COLORS.prueft,
  },
  blockiert: {
    form: 'eckig',
    glyph: GLYPH_BLOCKIERT,
    schirm: SCHIRM_BLOCKIERT,
    farbe: DESK_STATE_COLORS.blockiert,
  },
  eskaliert: {
    form: 'dreieck',
    glyph: GLYPH_ESKALIERT,
    schirm: SCHIRM_ESKALIERT,
    farbe: DESK_STATE_COLORS.eskaliert,
  },
};

/** The bubble as rectangles: outline in the state's colour, glyph in ink. */
export function kugelRects(state: DeskState): PixelRect[] {
  const bild = KUGELN[state];
  const anker = GLYPH_ANKER[bild.form];
  const blase = spriteRects(BLASEN[bild.form], { R: bild.farbe, B: PALETTE.papier });
  const glyph = spriteRects(bild.glyph, { G: PALETTE.ink }).map((rect) => ({
    ...rect,
    x: rect.x + anker.x,
    y: rect.y + anker.y,
  }));
  return [...blase, ...glyph];
}

// ---------------------------------------------------------------------------
// Where everything stands
// ---------------------------------------------------------------------------

/**
 * The tile's coordinate system, in pixels — 44 across, 28 down.
 *
 * Named rather than scattered through the markup because the depth order is the
 * whole trick of a half-perspective scene and it is not obvious from any single
 * number: chair, then person, then desk, then the things on the desk. Draw the
 * desk before the person and the person sits on the table.
 */
export const SZENE = { breite: 44, hoehe: 28 } as const;

/** The half-perspective the room is drawn in: seen from the front, slightly above. */
export const MOEBEL = {
  stuhl: { x: 11, y: 8, w: 20, h: 11 },
  /**
   * The chair with nobody in it — pushed in, and narrower.
   *
   * The occupied chair is wide because a person is in front of it and only its
   * edges show. Drawn empty at that size it is a grey slab the width of the
   * desk, which reads as a sofa; found by looking at the first Feierabend
   * render. Pushed in under the desk, only the backrest stands above the top
   * edge — which is also what an office looks like after everyone has left.
   */
  stuhlLeer: { x: 18, y: 10, w: 8, h: 9 },
  figur: { x: 13, y: 3 },
  platteHell: { x: 1, y: 17, w: 41, h: 1 },
  platte: { x: 1, y: 18, w: 41, h: 1 },
  blende: { x: 3, y: 19, w: 36, h: 3 },
  beinLinks: { x: 4, y: 22, w: 3, h: 5 },
  beinRechts: { x: 35, y: 22, w: 3, h: 5 },
  tastatur: { x: 16, y: 16, w: 10, h: 1 },
  tasse: { x: 30, y: 15, w: 3, h: 2 },
  henkel: { x: 33, y: 15, w: 1, h: 1 },
  blase: { x: 30, y: 0 },
} as const;

export const SCHIRM = {
  rahmen: { x: 2, y: 7, w: 11, h: 9 },
  flaeche: { x: 3, y: 8, w: 9, h: 7 },
  fuss: { x: 6, y: 16, w: 3, h: 1 },
  inhaltX: 4,
  inhaltY: 9,
} as const;

/** What the monitor shows, already offset into the screen's interior. */
export function schirmRects(state: DeskState | null): PixelRect[] {
  const muster = state === null ? null : KUGELN[state].schirm;
  if (!muster) return [];
  return spriteRects(muster, { G: PALETTE.schirmText }).map((rect) => ({
    ...rect,
    x: rect.x + SCHIRM.inhaltX,
    y: rect.y + SCHIRM.inhaltY,
  }));
}

/** The plant in the corner — furniture, so the empty room is still a room. */
export const PFLANZE = [
  '..G.G.G..',
  '.GGDGDGG.',
  '..GGDGG..',
  '...GDG...',
  '....D....',
  '..TTTTT..',
  '..TTTTT..',
  '...TTT...',
] as const;

export const PFLANZE_PALETTE: Record<string, string> = {
  G: PALETTE.pflanze,
  D: PALETTE.pflanzeDunkel,
  T: PALETTE.topf,
};

/**
 * The window, and why it has two palettes.
 *
 * `F` frame · `S` sky · `K` cross-bar. The empty room swaps `S` for the evening
 * colour, which is the whole of "Feierabendbüro": the same window, later. A
 * second sprite would have been a second thing to keep in step for no gain.
 */
export const FENSTER = [
  'FFFFFFFFFFFFF',
  'FSSSSSKSSSSSF',
  'FSSSSSKSSSSSF',
  'FSSSSSKSSSSSF',
  'FKKKKKKKKKKKF',
  'FSSSSSKSSSSSF',
  'FSSSSSKSSSSSF',
  'FSSSSSKSSSSSF',
  'FFFFFFFFFFFFF',
] as const;

export function fensterPalette(abend: boolean): Record<string, string> {
  return {
    F: PALETTE.rahmen,
    K: PALETTE.rahmen,
    S: abend ? PALETTE.abend : PALETTE.himmel,
  };
}

/** The wall clock — the one thing in the room that says an office has hours. */
export const UHR = [
  '..MMMMM..',
  '.MPPPPPM.',
  'MPPPIPPPM',
  'MPPPIPPPM',
  'MPPPIIPPM',
  'MPPPPPPPM',
  '.MPPPPPM.',
  '..MMMMM..',
] as const;

export const UHR_PALETTE: Record<string, string> = {
  M: PALETTE.metall,
  P: PALETTE.papier,
  I: PALETTE.ink,
};

/** Every sprite in this module, so a test can walk all of them. */
export const ALLE_SPRITES: ReadonlyArray<{ name: string; rows: readonly string[] }> = [
  { name: 'FIGUR', rows: FIGUR },
  { name: 'BLASE_RUND', rows: BLASE_RUND },
  { name: 'BLASE_ECKIG', rows: BLASE_ECKIG },
  { name: 'BLASE_DREIECK', rows: BLASE_DREIECK },
  { name: 'PFLANZE', rows: PFLANZE },
  { name: 'FENSTER', rows: FENSTER },
  { name: 'UHR', rows: UHR },
  ...DESK_STATES.map((state) => ({ name: `GLYPH ${state}`, rows: KUGELN[state].glyph })),
  ...DESK_STATES.flatMap((state) => {
    const schirm = KUGELN[state].schirm;
    return schirm ? [{ name: `SCHIRM ${state}`, rows: schirm }] : [];
  }),
];
