import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLEET, SIZE, key, canPlace, shipCells, randomFleet, isValidFleet, resolveShot, coordName,
} from '../game.js';

test('fleet is 5, 4, 3, 3, 2', () => {
  assert.deepEqual(FLEET.map((s) => s.length).sort(), [2, 3, 3, 4, 5]);
});

test('canPlace rejects out of bounds', () => {
  assert.equal(canPlace([], shipCells(0, 8, 3, true)), false);
  assert.equal(canPlace([], shipCells(8, 0, 3, false)), false);
  assert.equal(canPlace([], shipCells(0, 7, 3, true)), true);
});

test('canPlace rejects overlap and touching, also diagonal', () => {
  const ships = [{ id: 'kruiser', cells: shipCells(4, 4, 3, true) }];
  assert.equal(canPlace(ships, shipCells(4, 5, 2, false)), false);
  assert.equal(canPlace(ships, shipCells(5, 4, 2, true)), false);
  assert.equal(canPlace(ships, shipCells(5, 7, 2, true)), false);
  assert.equal(canPlace(ships, shipCells(3, 3, 1, true)), false);
  assert.equal(canPlace(ships, shipCells(6, 4, 2, true)), true);
  assert.equal(canPlace(ships, shipCells(4, 8, 2, true)), true);
});

test('randomFleet always gives a valid fleet', () => {
  for (let i = 0; i < 500; i++) assert.ok(isValidFleet(randomFleet()));
});

test('isValidFleet rejects wrong lengths and touching ships', () => {
  const good = randomFleet();
  assert.ok(isValidFleet(good));
  assert.equal(isValidFleet(good.slice(1)), false);
  const bad = good.map((s) => ({ ...s, cells: s.cells.slice(0, 1) }));
  assert.equal(isValidFleet(bad), false);
});

test('resolveShot: miss, hit, sunk, allSunk', () => {
  const ships = [
    { id: 'torpedojager', cells: [[0, 0], [0, 1]] },
    { id: 'kruiser', cells: [[5, 5], [6, 5], [7, 5]] },
  ];
  assert.deepEqual(resolveShot(ships, [], 9, 9), { result: 'miss' });
  assert.deepEqual(resolveShot(ships, [], 0, 0), { result: 'hit' });
  const sunk = resolveShot(ships, [key(0, 0)], 0, 1);
  assert.equal(sunk.result, 'sunk');
  assert.equal(sunk.ship.id, 'torpedojager');
  assert.equal(sunk.allSunk, false);
  const last = resolveShot(ships, [key(0, 0), key(0, 1), key(5, 5), key(6, 5)], 7, 5);
  assert.equal(last.result, 'sunk');
  assert.equal(last.allSunk, true);
});

test('resolveShot is repeatable for the same shot', () => {
  const ships = [{ id: 'torpedojager', cells: [[0, 0], [0, 1]] }];
  const received = [key(0, 0), key(0, 1)];
  assert.equal(resolveShot(ships, received, 0, 1).result, 'sunk');
});

test('coordName uses letter for column and number for row', () => {
  assert.equal(coordName(0, 0), 'A1');
  assert.equal(coordName(SIZE - 1, SIZE - 1), 'J10');
  assert.equal(coordName(4, 1), 'B5');
});
