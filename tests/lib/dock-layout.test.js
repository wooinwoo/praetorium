import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTOR_PANEL_ID,
  MAX_WORKER_DOCK_PANES,
  PROCESS_PANEL_ID,
  canSplitDockPanel,
  collectDockPanels,
  countWorkerDockPanes,
  createDockLayout,
  filterDockLayout,
  findDockGroup,
  mapDockInsertionIndex,
  moveDockPanel,
  reconcileDockLayout,
  updateDockRatio,
  workerPanelId,
} from '../../src/lib/dock-layout.js';

function parentSplit(layout, groupId) {
  if (!layout || layout.type === 'group') return null;
  if (layout.children.some(child => child.type === 'group' && child.id === groupId)) return layout;
  return parentSplit(layout.children[0], groupId) || parentSplit(layout.children[1], groupId);
}

function nodeIds(layout, ids = []) {
  ids.push(layout.id);
  if (layout.type === 'split') layout.children.forEach(child => nodeIds(child, ids));
  return ids;
}

function paneShares(layout, share = 1, shares = []) {
  if (layout.type === 'group') shares.push(share);
  else {
    paneShares(layout.children[0], share * layout.ratio, shares);
    paneShares(layout.children[1], share * (1 - layout.ratio), shares);
  }
  return shares;
}

test('dock layout starts with separate Director chat, process, and Worker tabs', () => {
  const layout = createDockLayout(['t-1', 't-2'], 't-2');

  assert.equal(layout.type, 'split');
  assert.equal(layout.dir, 'h');
  assert.deepEqual(findDockGroup(layout, 'director-group').tabs, [DIRECTOR_PANEL_ID, PROCESS_PANEL_ID]);
  assert.deepEqual(findDockGroup(layout, 'worker-group').tabs, [workerPanelId('t-1'), workerPanelId('t-2')]);
  assert.equal(findDockGroup(layout, 'worker-group').active, workerPanelId('t-2'));
});

test('a Worker tab can reorder inside a group or split on every pane edge', () => {
  const initial = createDockLayout(['t-1', 't-2'], 't-1');
  const reordered = moveDockPanel(initial, workerPanelId('t-2'), 'worker-group', 'center', 0);
  assert.deepEqual(findDockGroup(reordered, 'worker-group').tabs, [workerPanelId('t-2'), workerPanelId('t-1')]);

  for (const [position, dir, index] of [['left', 'h', 0], ['right', 'h', 1], ['top', 'v', 0], ['bottom', 'v', 1]]) {
    const moved = moveDockPanel(initial, workerPanelId('t-2'), 'director-group', position);
    const groupId = `group:${workerPanelId('t-2')}`;
    const split = parentSplit(moved, groupId);
    assert.equal(split.dir, dir, position);
    assert.equal(split.children[index].id, groupId, position);
    assert.deepEqual(new Set(collectDockPanels(moved)), new Set([DIRECTOR_PANEL_ID, PROCESS_PANEL_ID, workerPanelId('t-1'), workerPanelId('t-2')]));
  }
});

test('reconciliation removes stale tasks and adds each current Worker once', () => {
  const initial = createDockLayout(['old-1', 'old-2'], 'old-1');
  const split = moveDockPanel(initial, workerPanelId('old-2'), 'director-group', 'bottom');
  const reconciled = reconcileDockLayout(split, ['old-2', 'new-1'], 'new-1');
  const panels = collectDockPanels(reconciled);

  assert.deepEqual(new Set(panels), new Set([DIRECTOR_PANEL_ID, PROCESS_PANEL_ID, workerPanelId('old-2'), workerPanelId('new-1')]));
  assert.equal(panels.length, 4);
  assert.equal(panels.includes(workerPanelId('old-1')), false);
});

test('legacy Director layouts gain the process tab without resetting geometry', () => {
  const legacy = {
    type: 'split', id: 'split:root', dir: 'h', ratio: .68, children: [
      { type: 'group', id: 'director-group', tabs: [DIRECTOR_PANEL_ID], active: DIRECTOR_PANEL_ID },
      { type: 'group', id: 'worker-group', tabs: [workerPanelId('t-1')], active: workerPanelId('t-1') },
    ],
  };
  const reconciled = reconcileDockLayout(legacy, ['t-1']);

  assert.equal(reconciled.ratio, .68);
  assert.deepEqual(findDockGroup(reconciled, 'director-group').tabs, [DIRECTOR_PANEL_ID, PROCESS_PANEL_ID]);
});

test('split ratios clamp and Worker visibility filtering preserves core tabs', () => {
  const layout = createDockLayout(['t-1'], 't-1');
  assert.equal(updateDockRatio(layout, 'split:root', 9).ratio, .82);
  assert.equal(updateDockRatio(layout, 'split:root', -.2).ratio, .18);
  assert.deepEqual(collectDockPanels(filterDockLayout(layout, panelId => !panelId.startsWith('worker:'))), [DIRECTOR_PANEL_ID, PROCESS_PANEL_ID]);
});

test('core tab reorder maps filtered positions around hidden Worker tabs', () => {
  const layout = { type: 'group', id: 'mixed', tabs: [DIRECTOR_PANEL_ID, workerPanelId('t-1'), PROCESS_PANEL_ID], active: DIRECTOR_PANEL_ID };
  const visible = filterDockLayout(layout, panelId => !panelId.startsWith('worker:'));
  const index = mapDockInsertionIndex(layout, visible, 'mixed', 2);
  const moved = moveDockPanel(layout, DIRECTOR_PANEL_ID, 'mixed', 'center', index);

  assert.equal(index, 3);
  assert.deepEqual(collectDockPanels(filterDockLayout(moved, panelId => !panelId.startsWith('worker:'))), [PROCESS_PANEL_ID, DIRECTOR_PANEL_ID]);
});

test('corrupt persisted ids and invalid task ids recover without duplicate tabs or nodes', () => {
  const corrupt = {
    type: 'split', id: 'duplicate', dir: 'h', ratio: 4, children: [
      { type: 'group', id: 'duplicate', tabs: [DIRECTOR_PANEL_ID, DIRECTOR_PANEL_ID], active: 'missing' },
      { type: 'split', id: 'duplicate', dir: 'v', ratio: 0, children: [
        { type: 'group', id: 'duplicate', tabs: [workerPanelId('t-1')], active: workerPanelId('t-1') },
        { type: 'group', id: 'duplicate', tabs: [workerPanelId('t-2')], active: workerPanelId('t-2') },
      ] },
    ],
  };
  const recovered = reconcileDockLayout(corrupt, ['t-1', '', null, 't-1', 't-2']);

  assert.deepEqual(collectDockPanels(recovered), [DIRECTOR_PANEL_ID, PROCESS_PANEL_ID, workerPanelId('t-1'), workerPanelId('t-2')]);
  assert.equal(new Set(nodeIds(recovered)).size, nodeIds(recovered).length);
  assert.equal(recovered.ratio, .82);
  assert.equal(recovered.children[1].ratio, .5);
});

test('Worker splits stay within the live trace connection budget', () => {
  const taskIds = ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6'];
  let layout = createDockLayout(taskIds, 't-1');
  layout = moveDockPanel(layout, workerPanelId('t-2'), 'director-group', 'left');
  layout = moveDockPanel(layout, workerPanelId('t-3'), 'director-group', 'right');
  layout = moveDockPanel(layout, workerPanelId('t-4'), 'director-group', 'top');

  assert.equal(countWorkerDockPanes(layout), MAX_WORKER_DOCK_PANES);
  assert.equal(canSplitDockPanel(layout, workerPanelId('t-5')), false);
  assert.equal(moveDockPanel(layout, workerPanelId('t-5'), 'director-group', 'bottom'), layout);

  const overflow = {
    type: 'split', id: 'root', dir: 'h', ratio: .5, children: [
      { type: 'group', id: 'director-group', tabs: [DIRECTOR_PANEL_ID], active: DIRECTOR_PANEL_ID },
      ['t-1', 't-2', 't-3', 't-4', 't-5'].reduceRight((next, taskId, index) => {
        const pane = { type: 'group', id: `worker-${index}`, tabs: [workerPanelId(taskId)], active: workerPanelId(taskId) };
        return next ? { type: 'split', id: `worker-split-${index}`, dir: 'v', ratio: .5, children: [pane, next] } : pane;
      }, null),
    ],
  };
  const recovered = reconcileDockLayout(overflow, taskIds.slice(0, 5));
  assert.equal(countWorkerDockPanes(recovered), MAX_WORKER_DOCK_PANES);
  assert.deepEqual(new Set(collectDockPanels(recovered)), new Set([DIRECTOR_PANEL_ID, PROCESS_PANEL_ID, ...taskIds.slice(0, 5).map(workerPanelId)]));
});

test('repeated nested splits rebalance before a pane becomes unusably small', () => {
  let layout = createDockLayout(['t-1', 't-2', 't-3', 't-4']);
  layout = moveDockPanel(layout, workerPanelId('t-2'), 'worker-group', 'left');
  layout = moveDockPanel(layout, workerPanelId('t-3'), 'worker-group', 'left');
  layout = moveDockPanel(layout, workerPanelId('t-4'), 'worker-group', 'left');

  assert.ok(Math.min(...paneShares(layout)) >= .08);
  assert.equal(layout.ratio, .64);
});
