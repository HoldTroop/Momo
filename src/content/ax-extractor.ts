// Type declarations for Chrome extension APIs
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
      frameId?: number;
      id?: string;
      url?: string;
    }
    const onMessage: {
      addListener: (callback: (message: any, sender: MessageSender, sendResponse: (response: any) => void) => boolean | void) => void;
    };
    function sendMessage(message: any, callback: (response: any) => void): void;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      active?: boolean;
    }
    function sendMessage(tabId: number, message: any, callback: (response: any) => void): void;
  }
  namespace scripting {
    function executeScript(options: any): Promise<any[]>;
  }
}

interface AxNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  states: string[];
  attributes: Record<string, string>;
  childIds: number[];
  backendDOMNodeId: number;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

interface AxTree {
  nodes: AxNode[];
}

class AxTreeExtractor {
  private cdpSessionId: string | null = null;
  private observer: MutationObserver | null = null;
  private lastSnapshot: AxTree | null = null;
  private snapshotCallbacks: Map<string, (tree: AxTree) => void> = new Map();
  private requestId = 0;

  constructor() {
    this.init();
  }

  private async init() {
    // Listen for messages from service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    // Request CDP attachment from service worker
    await this.attachToCdp();
  }

  private async attachToCdp() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CDP_ATTACH_REQUEST' });
      if (response?.sessionId) {
        this.cdpSessionId = response.sessionId;
        console.log('[AX Extractor] CDP attached:', this.cdpSessionId);
      }
    } catch (e) {
      console.log('[AX Extractor] CDP not available, using fallback');
    }
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'GET_AX_TREE':
        this.getAxTree().then(tree => sendResponse({ axTree: tree }));
        break;
      case 'CDP_ATTACHED':
        if (message.payload?.sessionId) {
          this.cdpSessionId = message.payload.sessionId;
          console.log('[AX Extractor] CDP session updated:', this.cdpSessionId);
        }
        sendResponse({ success: true });
        break;
      case 'CDP_DETACHED':
        this.cdpSessionId = null;
        sendResponse({ success: true });
        break;
    }
  }

  async getAxTree(): Promise<AxTree | null> {
    if (this.cdpSessionId) {
      try {
        return await this.fetchAxTreeViaCdp();
      } catch (e) {
        console.warn('[AX Extractor] CDP fetch failed, using fallback:', e);
      }
    }
    return this.fetchAxTreeFallback();
  }

  private async fetchAxTreeViaCdp(): Promise<AxTree> {
    const response = await this.sendCdpCommand('Accessibility', 'getFullAXTree', {});
    return this.convertCdpAxTree(response);
  }

  private async fetchAxTreeFallback(): Promise<AxTree> {
    // Fallback: use document's accessibility tree via JS
    return new Promise(resolve => {
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          const tree = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          let nodeId = 0;
          const idMap = new WeakMap();

          function getId(node) {
            if (!idMap.has(node)) {
              idMap.set(node, ++nodeId);
            }
            return idMap.get(node);
          }

          while (walker.nextNode()) {
            const el = walker.currentNode as Element;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);

            // Get ARIA role
            const role = el.getAttribute('role') || getImplicitRole(el);

            tree.push({
              role,
              name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent?.trim().slice(0, 100) || '',
              value: (el as HTMLInputElement).value || '',
              description: el.getAttribute('aria-description') || '',
              states: getStates(el),
              attributes: getAttributes(el),
              childIds: Array.from(el.children).map(getId),
              backendDOMNodeId: getId(el),
              rect: rect.width > 0 && rect.height > 0 ? {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
              } : undefined,
            });
          }

          function getImplicitRole(el) {
            const tag = el.tagName.toLowerCase();
            const type = (el as HTMLInputElement).type;
            const roles: Record<string, string> = {
              'a': 'link', 'button': 'button', 'input': type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox',
              'select': 'combobox', 'textarea': 'textbox', 'option': 'option', 'img': 'img',
              'h1': 'heading', 'h2': 'heading', 'h3': 'heading', 'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
              'nav': 'navigation', 'main': 'main', 'aside': 'complementary', 'header': 'banner', 'footer': 'contentinfo',
              'form': 'form', 'table': 'table', 'ul': 'list', 'ol': 'list', 'li': 'listitem',
            };
            return roles[tag] || 'generic';
          }

          function getStates(el) {
            const states = [];
            if (el.hasAttribute('disabled') || (el as HTMLInputElement).disabled) states.push('disabled');
            if (el.hasAttribute('required')) states.push('required');
            if (el.hasAttribute('readonly')) states.push('readonly');
            if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') states.push('hidden');
            if (el.hasAttribute('aria-invalid') && el.getAttribute('aria-invalid') === 'true') states.push('invalid');
            if (el === document.activeElement) states.push('focused');
            if (el.checkVisibility()) states.push('visible'); else states.push('invisible');
            return states;
          }

          function getAttributes(el) {
            const attrs: Record<string, string> = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }
            return attrs;
          }

          (window as any).__axTreeSnapshot = { nodes: tree };
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      // Wait a tick for script to execute
      setTimeout(() => {
        const snapshot = (window as any).__axTreeSnapshot;
        resolve(snapshot || { nodes: [] });
      }, 100);
    });
  }

  private convertCdpAxTree(cdpTree: any): AxTree {
    // Convert CDP accessibility tree format to our internal format
    return {
      nodes: (cdpTree.nodes || []).map((node: any) => ({
        role: node.role?.value || 'generic',
        name: node.name?.value || '',
        value: node.value?.value || '',
        description: node.description?.value || '',
        states: (node.states || []).map((s: any) => s.value),
        attributes: node.attributes || {},
        childIds: node.childIds || [],
        backendDOMNodeId: node.backendDOMNodeId,
        rect: node.rect ? {
          x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height,
          top: node.rect.y, right: node.rect.x + node.rect.width, bottom: node.rect.y + node.rect.height, left: node.rect.x
        } : undefined,
      })),
    };
  }

  private async sendCdpCommand(domain: string, command: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CDP_COMMAND',
        payload: { domain, command, params, sessionId: this.cdpSessionId },
      }, response => {
        if (response?.error) reject(new Error(response.error));
        else resolve(response?.result);
      });
    });
  }

  startObserving() {
    if (this.observer) return;

    this.observer = new MutationObserver(mutations => {
      // Debounce snapshot updates
      clearTimeout((this as any).debounceTimer);
      (this as any).debounceTimer = setTimeout(() => {
        this.getAxTree().then(tree => {
          this.lastSnapshot = tree;
          this.notifyCallbacks(tree);
        });
      }, 300);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-*', 'role', 'disabled', 'hidden', 'class', 'id'],
    });
  }

  stopObserving() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private notifyCallbacks(tree: AxTree) {
    for (const [, callback] of this.snapshotCallbacks) {
      try {
        callback(tree);
      } catch (e) {
        console.warn('[AX Extractor] Callback error:', e);
      }
    }
  }
}

// Initialize extractor
const extractor = new AxTreeExtractor();
extractor.startObserving();

// Export for debugging
(window as any).__axExtractor = extractor;

console.log('[AX Extractor] Initialized');