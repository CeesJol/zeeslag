export const SIZE = 10;
export const LETTERS = 'ABCDEFGHIJ';

export const FLEET = [
  { id: 'vliegdekschip', name: 'Vliegdekschip', length: 5 },
  { id: 'slagschip', name: 'Slagschip', length: 4 },
  { id: 'kruiser', name: 'Kruiser', length: 3 },
  { id: 'onderzeeer', name: 'Onderzeeër', length: 3 },
  { id: 'torpedojager', name: 'Torpedojager', length: 2 },
];

export const key = (r, c) => `${r},${c}`;
export const coordName = (r, c) => `${LETTERS[c]}${r + 1}`;
export const shipName = (id) => FLEET.find((s) => s.id === id)?.name ?? id;

export function shipCells(r, c, length, horizontal) {
  return Array.from({ length }, (_, i) => (horizontal ? [r, c + i] : [r + i, c]));
}

// Classic rule: ships may not touch, also not diagonally.
export function canPlace(ships, cells) {
  const inBounds = cells.every(([r, c]) => r >= 0 && r < SIZE && c >= 0 && c < SIZE);
  if (!inBounds) return false;
  const blocked = new Set();
  for (const ship of ships) {
    for (const [r, c] of ship.cells) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) blocked.add(key(r + dr, c + dc));
      }
    }
  }
  return cells.every(([r, c]) => !blocked.has(key(r, c)));
}

export function randomFleet(rand = Math.random) {
  for (;;) {
    const ships = [];
    for (const def of FLEET) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const horizontal = rand() < 0.5;
        const r = Math.floor(rand() * SIZE);
        const c = Math.floor(rand() * SIZE);
        const cells = shipCells(r, c, def.length, horizontal);
        if (canPlace(ships, cells)) {
          ships.push({ id: def.id, cells });
          break;
        }
      }
    }
    if (ships.length === FLEET.length) return ships;
  }
}

export function isFleetComplete(ships) {
  return FLEET.every((def) => ships.some((s) => s.id === def.id));
}

export function isValidFleet(ships) {
  if (ships.length !== FLEET.length || !isFleetComplete(ships)) return false;
  const placed = [];
  for (const ship of ships) {
    const def = FLEET.find((d) => d.id === ship.id);
    if (ship.cells.length !== def.length || !canPlace(placed, ship.cells)) return false;
    placed.push(ship);
  }
  return true;
}

// `received` holds the keys of all earlier shots on this board. Pure, so a
// repeated shot (after a reconnect) gives the same answer again.
export function resolveShot(ships, received, r, c) {
  const all = new Set(received);
  all.add(key(r, c));
  const ship = ships.find((s) => s.cells.some(([sr, sc]) => sr === r && sc === c));
  if (!ship) return { result: 'miss' };
  const sunk = ship.cells.every(([sr, sc]) => all.has(key(sr, sc)));
  if (!sunk) return { result: 'hit' };
  const allSunk = ships.every((s) => s.cells.every(([sr, sc]) => all.has(key(sr, sc))));
  return { result: 'sunk', ship, allSunk };
}
