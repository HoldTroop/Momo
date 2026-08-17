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

async function initialize() {
  if (isInitialized) return;

  try {
    await persistence.init();
    await orchestrator.init();
    alarmManager.start();
    isInitialized = true;
    console.log('[SW] Autonomous Agent initialized');
  } catch (error) {
    console.error('[SW] Initialization failed:', error);
  }
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await persistence.init();
  } else if (details.reason === 'update') {
    await persistence.migrate(details.previousVersion);
  }
  await initialize();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  messageRouter.handle(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  portManager.handlePort(port);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  alarmManager.handleAlarm(alarm);
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

chrome.runtime.onSuspend.addListener(() => {
  console.log('[SW] Suspending, aborting task and detaching CDP...');
  orchestrator.suspend();
});

self.addEventListener('beforeunload', () => {
  orchestrator.suspend();
});

initialize();