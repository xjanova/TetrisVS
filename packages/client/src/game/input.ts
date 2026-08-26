import type { ActionName, Inputs, PlayerId, PlayerInput } from '@tetrisvs/core';

const KEYMAP: Record<string, [PlayerId, ActionName]> = {
  KeyA: [0, 'left'],
  KeyD: [0, 'right'],
  KeyS: [0, 'softDrop'],
  KeyW: [0, 'rotCW'],
  KeyQ: [0, 'rotCCW'],
  KeyE: [0, 'rot180'],
  Space: [0, 'hardDrop'],
  KeyC: [0, 'hold'],
  ArrowLeft: [1, 'left'],
  ArrowRight: [1, 'right'],
  ArrowDown: [1, 'softDrop'],
  ArrowUp: [1, 'rotCW'],
  Comma: [1, 'rotCCW'],
  Period: [1, 'rot180'],
  Enter: [1, 'hardDrop'],
  Slash: [1, 'hold'],
};

const PREVENT = new Set([...Object.keys(KEYMAP), 'Escape']);

/** Stable order so `signature()` is comparable between frames. */
const ORDER: ActionName[] = ['left', 'right', 'softDrop', 'hardDrop', 'rotCW', 'rotCCW', 'rot180', 'hold'];

/** Deterministic action order — two sets with the same members serialise alike. */
function ordered(set: ReadonlySet<ActionName>): ActionName[] {
  const out: ActionName[] = [];
  for (const action of ORDER) if (set.has(action)) out.push(action);
  return out;
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
}

export class LocalInput {
  private held = [new Set<ActionName>(), new Set<ActionName>()] as const;
  private pressed = [new Set<ActionName>(), new Set<ActionName>()] as const;
  private attached = false;

  private onDown = (event: KeyboardEvent) => {
    // Never eat a keystroke aimed at the room-code field.
    if (isTextTarget(event.target)) return;
    if (PREVENT.has(event.code)) event.preventDefault();
    const mapped = KEYMAP[event.code];
    if (!mapped) return;
    const [player, action] = mapped;
    // OS key-repeat re-fires keydown; only the first is an edge.
    if (!this.held[player].has(action)) this.pressed[player].add(action);
    this.held[player].add(action);
  };

  private onUp = (event: KeyboardEvent) => {
    const mapped = KEYMAP[event.code];
    if (!mapped) return;
    if (!isTextTarget(event.target)) event.preventDefault();
    const [player, action] = mapped;
    this.held[player].delete(action);
  };

  /**
   * Alt-tabbing away never delivers the matching keyup, so without this the
   * piece kept sliding into the wall while the window was in the background and
   * the player came back to a ruined board.
   */
  private onBlur = () => this.clear();

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.clear();
  };

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onDown, { passive: false });
    window.addEventListener('keyup', this.onUp, { passive: false });
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  detach() {
    this.attached = false;
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clear();
  }

  clear() {
    this.held[0].clear();
    this.held[1].clear();
    this.pressed[0].clear();
    this.pressed[1].clear();
  }

  consume(frame: number): Inputs {
    const build = (player: PlayerId): PlayerInput => ({
      frame,
      pressed: ordered(this.pressed[player]),
      held: ordered(this.held[player]),
    });
    const result: Inputs = [build(0), build(1)];
    this.pressed[0].clear();
    this.pressed[1].clear();
    return result;
  }

  /**
   * Online play has one player at the keyboard, so either control scheme drives
   * their board. Merging here avoids rebuilding two Sets every animation frame.
   */
  consumeMerged(frame: number): PlayerInput {
    const pressed: ActionName[] = [];
    const held: ActionName[] = [];
    for (const action of ORDER) {
      if (this.pressed[0].has(action) || this.pressed[1].has(action)) pressed.push(action);
      if (this.held[0].has(action) || this.held[1].has(action)) held.push(action);
    }
    this.pressed[0].clear();
    this.pressed[1].clear();
    return { frame, pressed, held };
  }

  /** Cheap comparison key for "did anything change since the last send?". */
  static signature(input: PlayerInput): string {
    return `${input.pressed.join(',')}|${input.held.join(',')}`;
  }
}
