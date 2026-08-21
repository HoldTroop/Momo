import { AgentOrchestrator } from './orchestrator.js';
import { PersistenceManager } from '../lib/persistence.js';
import { MessageRouter } from './message-router.js';
import { AlarmManager } from './alarm-manager.js';
import { PortManager } from './port-manager.js';

const persistence = new PersistenceManager();
const orchestrator = new AgentOrchestrator(persistence);
const messageRouter = new MessageRouter(orchestrator);
const alarmManager = new AlarmManager(orchestrator);
const portManager = new PortManager(orchestrator, messageRouter);

let isInitialized = false;
let initPromise: Promise<void> | null = null;

async function initialize(attempt = 0) {
  if (isInitialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await persistence.init();
      await orchestrator.init();
      alarmManager.start();
      isInitialized = true;
      if (import.meta.env.DEV) {
        console.log('[SW] Autonomous Agent initialized');
      }
      void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
        console.warn('[SW] setPanelBehavior failed:', err);
      });
    } catch (error) {
      console.error('[SW] Initialization failed:', error);
      // Alarm-based retry: setTimeout dies with the worker; chrome.alarms persists.
      const delay = Math.min(0.5 + attempt * 0.5, 2); // minutes, capped
      try {
        await chrome.alarms.create('agent-init-retry', { delayInMinutes: delay });
      } catch (e) {
        console.error('[SW] Failed to schedule init retry:', e);
      }
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

chrome.runtime.onStartup.addListener(() => void initialize());
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    if (details.reason === 'install') {
      await persistence.init();
    } else if (details.reason === 'update') {
      await persistence.migrate(details.previousVersion);
    }
  } catch (error) {
    console.error('[SW] onInstalled migration failed:', error);
  }
  await initialize();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  messageRouter.handle(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true;
});

// Manifest `externally_connectable` allows localhost pages to reach us; nothing
// from outside the extension is trusted, so reject every external message.
chrome.runtime.onMessageExternal.addListener((_message, _sender, sendResponse) => {
  sendResponse({ error: 'External messages are not accepted' });
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  portManager.handlePort(port);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'agent-init-retry') {
    void initialize();
    return;
  }
  alarmManager.handleAlarm(alarm).catch((err) => {
    console.error('[SW] Alarm handler failed:', err);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    orchestrator.handleStorageChange(changes);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    orchestrator.handleTabUpdate(tabId, tab);
  }
});

chrome.tabs.onActivated.addListener(() => {
  orchestrator.handleTabActivated();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  orchestrator.handleTabRemoved(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
  void orchestrator.suspend().catch((err) => console.error('[SW] Suspend cleanup failed:', err));
});

initialize();
