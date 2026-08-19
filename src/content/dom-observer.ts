import { redactAttributeValue } from '../lib/redaction.js';

interface DomChange {
  type: 'childList' | 'attributes' | 'characterData';
  target: string; // selector or xpath
  addedNodes?: string[];
  removedNodes?: string[];
  attributeName?: string;
  oldValue?: string;
  newValue?: string;
  data?: string;
  timestamp: number;
}

class DomObserver {
  private observer: MutationObserver | null = null;
  private changeBuffer: DomChange[] = [];
  private flushInterval: number | null = null;
  private maxBufferSize = 100;
  private callbacks: Set<(changes: DomChange[]) => void> = new Set();

  constructor() {
    this.init();
  }

  private init() {
    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const change: DomChange = {
          type: mutation.type,
          target: this.getSelector(mutation.target),
          timestamp: Date.now(),
        };

        if (mutation.type === 'childList') {
          change.addedNodes = Array.from(mutation.addedNodes)
            .filter(n => n.nodeType === Node.ELEMENT_NODE)
            .map(n => this.getSelector(n as Element));
          change.removedNodes = Array.from(mutation.removedNodes)
            .filter(n => n.nodeType === Node.ELEMENT_NODE)
            .map(n => this.getSelector(n as Element));
        } else if (mutation.type === 'attributes') {
          change.attributeName = mutation.attributeName || undefined;
          const attrName = change.attributeName ?? '';
          change.oldValue = mutation.oldValue ? redactAttributeValue(attrName, mutation.oldValue) : undefined;
          const rawNewValue = (mutation.target as Element).getAttribute(mutation.attributeName || '');
          change.newValue = rawNewValue != null ? redactAttributeValue(attrName, rawNewValue, { type: (mutation.target as HTMLElement).getAttribute?.('type') ?? undefined, name: (mutation.target as HTMLElement).getAttribute?.('name') ?? undefined, id: (mutation.target as HTMLElement).id ?? undefined }) : undefined;
        } else if (mutation.type === 'characterData') {
          change.target = this.getSelector(mutation.target.parentElement ?? mutation.target);
          change.data = (mutation.target.textContent || '').slice(0, 200);
        }

        this.bufferChange(change);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'id', 'style', 'disabled', 'hidden', 'aria-*', 'data-*', 'href', 'src', 'value'],
      characterData: true,
      characterDataOldValue: true,
    });

    this.flushInterval = window.setInterval(() => this.flush(), 1000);

    // Listen for messages
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    console.log('[DOM Observer] Initialized');
  }

  private getSelector(node: Node): string {
    if (node.nodeType !== Node.ELEMENT_NODE) return 'text';

    const el = node as Element;
    if (el.id) return `#${el.id}`;

    const path: string[] = [];
    let current: Element | null = el;

    while (current && current !== document.body && path.length < 5) {
      let selector = current.tagName.toLowerCase();

      if (current.className && typeof current.className === 'string') {
        const classes = current.className.split(' ').filter(c => c.length > 1).slice(0, 2);
        if (classes.length > 0) selector += `.${classes.join('.')}`;
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ') || el.tagName.toLowerCase();
  }

  private bufferChange(change: DomChange) {
    this.changeBuffer.push(change);

    if (this.changeBuffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  private flush() {
    if (this.changeBuffer.length === 0) return;

    const changes = [...this.changeBuffer];
    this.changeBuffer = [];

    for (const callback of this.callbacks) {
      try {
        callback(changes);
      } catch (e) {
        console.warn('[DOM Observer] Callback error:', e);
      }
    }

    // Also send to service worker
    chrome.runtime.sendMessage({
      type: 'DOM_CHANGES',
      payload: { changes },
    }).catch(() => {}); // Ignore if SW not ready
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'GET_RECENT_CHANGES':
        sendResponse({ changes: this.changeBuffer.slice(-50) });
        break;
      case 'REGISTER_CHANGE_CALLBACK':
        const callbackId = `cb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const callback = (changes: DomChange[]) => {
          chrome.runtime.sendMessage({
            type: 'DOM_CHANGES_CALLBACK',
            payload: { callbackId, changes },
          }).catch(() => {});
        };
        this.callbacks.add(callback);
        sendResponse({ callbackId });
        break;
      case 'UNREGISTER_CHANGE_CALLBACK':
        // In practice, we'd need to store the callback reference
        sendResponse({ success: true });
        break;
    }
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.callbacks.clear();
    this.changeBuffer = [];
  }
}

// Initialize observer
const domObserver = new DomObserver();

// Export for debugging
(window as any).__domObserver = domObserver;