import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import {
  connectionNotification, deriveGoalNotifications, deriveWorkerNotifications, mergeNotifications,
  reconcilePersistentGoalNotifications,
} from '../domain/notification-model.js';
import { useStoredState } from './usePraetorium.js';

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

export function useOperatorNotifications({ summary, summaryError, runtimeError, onNavigate }) {
  const [items, setItems] = useStoredState('praetorium.notifications', []);
  const [permission, setPermission] = useState(() => isTauri() ? 'unknown' : 'unavailable');
  const previousSummary = useRef(null);
  const previousBoard = useRef(null);
  const previousBoardAt = useRef(null);
  const previousConnection = useRef(null);
  const previousRuntimeError = useRef(undefined);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten;
    void isPermissionGranted().then(granted => setPermission(granted ? 'granted' : 'prompt')).catch(() => setPermission('unavailable'));
    void listen('operator-notification-open', event => {
      try { navigateRef.current?.(JSON.parse(String(event.payload || ''))); } catch { /* ignore malformed native payload */ }
    }).then(next => { unlisten = next; }).catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  const publish = useCallback(incoming => {
    if (!incoming.length) return;
    setItems(current => mergeNotifications(Array.isArray(current) ? current : [], incoming));
    if (permission !== 'granted' || !isTauri() || (!document.hidden && document.hasFocus())) return;
    for (const item of incoming) {
      void invoke('show_operator_notification', {
        title: item.title, body: item.body, payload: JSON.stringify(item),
      }).catch(() => {});
    }
  }, [permission, setItems]);

  useEffect(() => {
    if (!summary) return;
    const observedAt = new Date().toISOString();
    const previous = previousSummary.current;
    const incoming = deriveGoalNotifications(previous, summary, observedAt, previous?.observedAt);
    if (previous) publish(incoming);
    else if (incoming.length) setItems(current => mergeNotifications(Array.isArray(current) ? current : [], incoming));
    setItems(current => reconcilePersistentGoalNotifications(Array.isArray(current) ? current : [], summary, observedAt));
    previousSummary.current = summary;
  }, [publish, setItems, summary]);

  useEffect(() => {
    const tasks = summary?.notificationTasks;
    if (!Array.isArray(tasks)) return;
    const observedAt = new Date().toISOString();
    publish(deriveWorkerNotifications(previousBoard.current, tasks, observedAt, previousBoardAt.current));
    previousBoard.current = tasks;
    previousBoardAt.current = summary.observedAt || null;
  }, [publish, summary?.notificationTasks]);

  useEffect(() => {
    const connected = Boolean(summary) && !summaryError;
    if (previousConnection.current === null) {
      previousConnection.current = connected;
      return;
    }
    if (previousConnection.current && !connected) publish([connectionNotification(summaryError)]);
    previousConnection.current = connected;
  }, [publish, summary, summaryError]);

  useEffect(() => {
    if (previousRuntimeError.current === undefined) {
      previousRuntimeError.current = runtimeError || null;
      return;
    }
    if (runtimeError && runtimeError !== previousRuntimeError.current) publish([connectionNotification(runtimeError, new Date().toISOString(), 'runtime_error')]);
    previousRuntimeError.current = runtimeError || null;
  }, [publish, runtimeError]);

  const enableNative = useCallback(async () => {
    if (!isTauri()) return false;
    try {
      const granted = await isPermissionGranted() || await requestPermission() === 'granted';
      setPermission(granted ? 'granted' : 'denied');
      return granted;
    } catch {
      setPermission('unavailable');
      return false;
    }
  }, []);
  const markRead = useCallback(id => setItems(current => (current || []).map(item => item.id === id ? { ...item, read: true } : item)), [setItems]);
  const markAllRead = useCallback(() => setItems(current => (current || []).map(item => ({ ...item, read: true }))), [setItems]);
  const clearAll = useCallback(() => setItems(current => (current || []).filter(item => item?.persistent)), [setItems]);
  const notifications = Array.isArray(items) ? items : [];

  return {
    items: notifications,
    unread: notifications.filter(item => !item.read).length,
    permission,
    enableNative,
    markRead,
    markAllRead,
    clearAll,
  };
}
