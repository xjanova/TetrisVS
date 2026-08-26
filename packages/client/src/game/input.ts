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

export class LocalInput {
  private held = [new Set<ActionName>(), new Set<ActionName>()] as const;
  private pressed = [new Set<ActionName>(), new Set<ActionName>()] as const;

  private onDown = (event: KeyboardEvent) => {
    if (PREVENT.has(event.code)) event.preventDefault();
    const mapped = KEYMAP[event.code];
    if (!mapped) return;
    const [player, action] = mapped;
    if (!this.held[player].has(action)) this.pressed[player].add(action);
    this.held[player].add(action);
  };

  private onUp = (event: KeyboardEvent) => {
    const mapped = KEYMAP[event.code];
    if (!mapped) return;
    event.preventDefault();
    const [player, action] = mapped;
    this.held[player].delete(action);
  };

  attach() {
    window.addEventListener('keydown', this.onDown, { passive: false });
    window.addEventListener('keyup', this.onUp, { passive: false });
  }

  detach() {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    this.clear();
  }

  clear() {
    this.held.forEach((set) => set.clear());
    this.pressed.forEach((set) => set.clear());
  }

  consume(frame: number): Inputs {
    const input = (player: PlayerId): PlayerInput => ({
      frame,
      pressed: [...this.pressed[player]],
      held: [...this.held[player]],
    });
    const result: Inputs = [input(0), input(1)];
    this.pressed.forEach((set) => set.clear());
    return result;
  }
}
