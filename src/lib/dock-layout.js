export const DIRECTOR_PANEL_ID = 'director';
export const MAX_WORKER_DOCK_PANES = 4;
const MIN_DOCK_PANE_SHARE = .08;

export function workerPanelId(taskId) {
  return `worker:${taskId}`;
}

export function workerTaskId(panelId) {
  return String(panelId || '').startsWith('worker:') ? String(panelId).slice(7) : '';
}

function group(id, tabs, active = tabs[0]) {
  return { type: 'group', id, tabs, active };
}

function split(id, dir, ratio, first, second) {
  return { type: 'split', id, dir, ratio, children: [first, second] };
}

function clampRatio(value) {
  return Math.max(.18, Math.min(.82, Number(value) || .5));
}

function normalizedTaskIds(taskIds) {
  return [...new Set((Array.isArray(taskIds) ? taskIds : [])
    .filter(taskId => typeof taskId === 'string' && taskId.trim())
    .map(taskId => taskId.trim()))];
}

function uniqueNodeId(preferred, seen) {
  let id = preferred;
  let suffix = 2;
  while (seen.has(id)) id = `${preferred}:${suffix++}`;
  seen.add(id);
  return id;
}

export function createDockLayout(taskIds = [], selectedTaskId = '') {
  const workers = normalizedTaskIds(taskIds).map(workerPanelId);
  const director = group('director-group', [DIRECTOR_PANEL_ID]);
  if (!workers.length) return director;
  const selected = workerPanelId(selectedTaskId);
  const workerGroup = group('worker-group', workers, workers.includes(selected) ? selected : workers[0]);
  return split('split:root', 'h', .64, director, workerGroup);
}

function cleanDockLayout(layout, validPanels) {
  const seenPanels = new Set();
  const seenNodes = new Set();
  let nodeCount = 0;

  const clean = (node, depth = 0) => {
    if (!node || depth > 12 || ++nodeCount > 64) return null;
    if (node.type === 'group') {
      const tabs = Array.isArray(node.tabs) ? node.tabs.filter(panelId => {
        if (!validPanels.has(panelId) || seenPanels.has(panelId)) return false;
        seenPanels.add(panelId);
        return true;
      }) : [];
      if (!tabs.length) return null;
      const preferredId = typeof node.id === 'string' && node.id ? node.id : `group:${tabs[0]}`;
      const id = uniqueNodeId(preferredId, seenNodes);
      return group(id, tabs, tabs.includes(node.active) ? node.active : tabs[0]);
    }
    if (node.type !== 'split' || !Array.isArray(node.children) || node.children.length !== 2) return null;
    const first = clean(node.children[0], depth + 1);
    const second = clean(node.children[1], depth + 1);
    if (!first) return second;
    if (!second) return first;
    const preferredId = typeof node.id === 'string' && node.id ? node.id : `split:${depth}:${nodeCount}`;
    const id = uniqueNodeId(preferredId, seenNodes);
    return split(id, node.dir === 'v' ? 'v' : 'h', clampRatio(node.ratio), first, second);
  };

  return clean(layout);
}

export function collectDockPanels(layout, panels = []) {
  if (!layout) return panels;
  if (layout.type === 'group') panels.push(...layout.tabs);
  else if (layout.type === 'split') {
    collectDockPanels(layout.children[0], panels);
    collectDockPanels(layout.children[1], panels);
  }
  return panels;
}

function updateGroup(layout, groupId, update) {
  if (!layout) return layout;
  if (layout.type === 'group') return layout.id === groupId ? update(layout) : layout;
  return { ...layout, children: layout.children.map(child => updateGroup(child, groupId, update)) };
}

export function findDockGroup(layout, groupId) {
  if (!layout) return null;
  if (layout.type === 'group') return layout.id === groupId ? layout : null;
  return findDockGroup(layout.children[0], groupId) || findDockGroup(layout.children[1], groupId);
}

function findPanel(layout, panelId) {
  if (!layout) return null;
  if (layout.type === 'group') {
    const index = layout.tabs.indexOf(panelId);
    return index === -1 ? null : { groupId: layout.id, index };
  }
  return findPanel(layout.children[0], panelId) || findPanel(layout.children[1], panelId);
}

function removePanel(layout, panelId) {
  if (!layout) return null;
  if (layout.type === 'group') {
    const tabs = layout.tabs.filter(tab => tab !== panelId);
    if (!tabs.length) return null;
    return { ...layout, tabs, active: tabs.includes(layout.active) ? layout.active : tabs[0] };
  }
  const children = layout.children.map(child => removePanel(child, panelId));
  if (!children[0]) return children[1];
  if (!children[1]) return children[0];
  return { ...layout, children };
}

function collectDockGroups(layout, groups = []) {
  if (!layout) return groups;
  if (layout.type === 'group') groups.push(layout);
  else layout.children.forEach(child => collectDockGroups(child, groups));
  return groups;
}

export function countWorkerDockPanes(layout) {
  return collectDockGroups(layout).filter(node => node.tabs.some(workerTaskId)).length;
}

export function canSplitDockPanel(layout, panelId) {
  if (!findPanel(layout, panelId)) return false;
  if (!workerTaskId(panelId)) return true;
  return countWorkerDockPanes(removePanel(layout, panelId)) < MAX_WORKER_DOCK_PANES;
}

function replaceGroup(layout, groupId, replacement) {
  if (layout.type === 'group') return layout.id === groupId ? replacement : layout;
  return { ...layout, children: layout.children.map(child => replaceGroup(child, groupId, replacement)) };
}

export function activateDockPanel(layout, panelId) {
  const location = findPanel(layout, panelId);
  if (!location) return layout;
  return updateGroup(layout, location.groupId, current => current.active === panelId ? current : { ...current, active: panelId });
}

export function moveDockPanel(layout, panelId, targetGroupId, position = 'center', targetIndex = Number.POSITIVE_INFINITY) {
  const source = findPanel(layout, panelId);
  const target = findDockGroup(layout, targetGroupId);
  if (!source || !target) return layout;
  if (!['left', 'right', 'top', 'bottom'].includes(position)) {
    let next = removePanel(layout, panelId);
    const remainingTarget = findDockGroup(next, targetGroupId);
    if (!remainingTarget) return layout;
    let index = Number.isFinite(targetIndex) ? targetIndex : remainingTarget.tabs.length;
    if (source.groupId === targetGroupId && source.index < index) index -= 1;
    index = Math.max(0, Math.min(remainingTarget.tabs.length, index));
    return updateGroup(next, targetGroupId, current => {
      const tabs = [...current.tabs];
      tabs.splice(index, 0, panelId);
      return { ...current, tabs, active: panelId };
    });
  }

  if (source.groupId === targetGroupId && target.tabs.length === 1) return layout;
  if (!canSplitDockPanel(layout, panelId)) return layout;
  const next = removePanel(layout, panelId);
  const remainingTarget = findDockGroup(next, targetGroupId);
  if (!remainingTarget) return layout;
  const panelGroup = group(`group:${panelId}`, [panelId]);
  const horizontal = position === 'left' || position === 'right';
  const panelFirst = position === 'left' || position === 'top';
  const replacement = split(
    `split:${panelId}:${targetGroupId}:${position}`,
    horizontal ? 'h' : 'v',
    .5,
    panelFirst ? panelGroup : remainingTarget,
    panelFirst ? remainingTarget : panelGroup,
  );
  return repairTinyDockPanes(replaceGroup(next, targetGroupId, replacement));
}

function enforceWorkerDockPaneLimit(layout) {
  const workerGroups = collectDockGroups(layout).filter(node => node.tabs.some(workerTaskId));
  if (workerGroups.length <= MAX_WORKER_DOCK_PANES) return layout;
  let next = layout;
  const targetGroupId = workerGroups[0].id;
  for (const source of workerGroups.slice(MAX_WORKER_DOCK_PANES)) {
    for (const panelId of source.tabs.filter(workerTaskId)) {
      next = moveDockPanel(next, panelId, targetGroupId, 'center');
    }
  }
  return next;
}

function minimumDockPaneShare(layout, share = 1) {
  if (layout.type === 'group') return share;
  return Math.min(
    minimumDockPaneShare(layout.children[0], share * layout.ratio),
    minimumDockPaneShare(layout.children[1], share * (1 - layout.ratio)),
  );
}

function balanceDockRatios(layout) {
  if (layout.type === 'group') return layout;
  const children = layout.children.map(balanceDockRatios);
  const firstCount = collectDockGroups(children[0]).length;
  const secondCount = collectDockGroups(children[1]).length;
  return { ...layout, ratio: firstCount / (firstCount + secondCount), children };
}

function repairTinyDockPanes(layout, share = 1) {
  if (layout.type === 'group') return layout;
  const children = [
    repairTinyDockPanes(layout.children[0], share * layout.ratio),
    repairTinyDockPanes(layout.children[1], share * (1 - layout.ratio)),
  ];
  const next = { ...layout, children };
  const groupCount = collectDockGroups(next).length;
  return minimumDockPaneShare(next, share) < MIN_DOCK_PANE_SHARE && share / groupCount >= MIN_DOCK_PANE_SHARE
    ? balanceDockRatios(next) : next;
}

export function updateDockRatio(layout, splitId, ratio) {
  if (!layout || layout.type === 'group') return layout;
  if (layout.id === splitId) return { ...layout, ratio: clampRatio(ratio) };
  return { ...layout, children: layout.children.map(child => updateDockRatio(child, splitId, ratio)) };
}

export function filterDockLayout(layout, predicate) {
  if (!layout) return null;
  if (layout.type === 'group') {
    const tabs = layout.tabs.filter(predicate);
    if (!tabs.length) return null;
    return { ...layout, tabs, active: tabs.includes(layout.active) ? layout.active : tabs[0] };
  }
  const children = layout.children.map(child => filterDockLayout(child, predicate));
  if (!children[0]) return children[1];
  if (!children[1]) return children[0];
  return { ...layout, children };
}

export function reconcileDockLayout(layout, taskIds = [], selectedTaskId = '') {
  const workerPanels = normalizedTaskIds(taskIds).map(workerPanelId);
  const validPanels = new Set([DIRECTOR_PANEL_ID, ...workerPanels]);
  let next = cleanDockLayout(layout, validPanels);
  if (!next) return createDockLayout(taskIds, selectedTaskId);

  const existing = new Set(collectDockPanels(next));
  if (!existing.has(DIRECTOR_PANEL_ID)) {
    next = split('split:director', 'h', .64, group('director-group', [DIRECTOR_PANEL_ID]), next);
    existing.add(DIRECTOR_PANEL_ID);
  }
  const missingWorkers = workerPanels.filter(panelId => !existing.has(panelId));
  if (missingWorkers.length) {
    const workerGroup = findFirstWorkerGroup(next);
    if (workerGroup) next = updateGroup(next, workerGroup.id, current => ({ ...current, tabs: [...current.tabs, ...missingWorkers] }));
    else {
      const selected = workerPanelId(selectedTaskId);
      const active = missingWorkers.includes(selected) ? selected : missingWorkers[0];
      next = split('split:workers', 'h', .64, next, group('worker-group', missingWorkers, active));
    }
  }
  return repairTinyDockPanes(enforceWorkerDockPaneLimit(next));
}

function findFirstWorkerGroup(layout) {
  if (!layout) return null;
  if (layout.type === 'group') return layout.tabs.some(workerTaskId) ? layout : null;
  return findFirstWorkerGroup(layout.children[0]) || findFirstWorkerGroup(layout.children[1]);
}
