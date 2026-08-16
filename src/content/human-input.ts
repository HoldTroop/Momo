// Human Input Simulation — Content Script Fallback
// Per Architecture Blueprint Section 7: transparent input, no deception
// "Human-like timing may be used only for usability—such as waiting for rendering or avoiding accidental double submission—not to deceive a destination site."
// NOTE: These produce untrusted events (isTrusted: false). For trusted events, use bridge via CDP Input API.

interface SimulationProfile {
  speed: number;
  jitter: number;
  errorRate: number;
}

class HumanInputSimulator {
  private profile: SimulationProfile;
  private isSimulating = false;

  constructor() {
    this.profile = { speed: 1.0, jitter: 0.0, errorRate: 0.0 };
    this.init();
  }

  private init() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true;
    });

    console.log('[Human Input] Initialized (content script fallback - untrusted events)');
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'SIMULATE_CLICK':
        this.simulateClick(message.payload.x, message.payload.y, message.payload.profile)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        break;
      case 'SIMULATE_TYPE':
        this.simulateType(message.payload.text, message.payload.profile)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        break;
      case 'SIMULATE_SCROLL':
        this.simulateScroll(message.payload.x, message.payload.y, message.payload.deltaX, message.payload.deltaY, message.payload.profile)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        break;
      case 'SIMULATE_MOUSE_MOVE':
        this.simulateMouseMove(message.payload.fromX, message.payload.fromY, message.payload.toX, message.payload.toY, message.payload.profile)
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        break;
      case 'SET_PROFILE':
        this.profile = { ...this.profile, ...message.payload };
        sendResponse({ success: true });
        break;
    }
  }

  async simulateClick(x: number, y: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };
    this.isSimulating = true;

    try {
      // Simple move to target
      await this.mouseMove(x, y, p);

      // Small dwell for usability (not deception)
      await this.sleep(20);

      // Click sequence
      this.dispatchMouseEvent('mousedown', x, y, 0);
      await this.sleep(10);
      this.dispatchMouseEvent('mouseup', x, y, 0);
      this.dispatchMouseEvent('click', x, y, 0);

    } finally {
      this.isSimulating = false;
    }
  }

  async simulateType(text: string, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };
    this.isSimulating = true;

    try {
      for (const ch of text) {
        // Key down
        this.dispatchKeyEvent('keydown', ch);
        // Small delay for usability
        await this.sleep(10);
        // Key up
        this.dispatchKeyEvent('keyup', ch);
        // Small inter-key delay
        await this.sleep(10);
      }
    } finally {
      this.isSimulating = false;
    }
  }

  async simulateScroll(x: number, y: number, deltaX: number, deltaY: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };

    // Use native wheel event (content script fallback)
    const el = document.elementFromPoint(x, y);
    if (el) {
      const steps = Math.max(1, Math.ceil(Math.abs(deltaY) / 50));
      for (let i = 0; i < steps; i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaX: deltaX / steps,
          deltaY: deltaY / steps,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }));
        await this.sleep(16 * p.speed);
      }
    }
  }

  async simulateMouseMove(fromX: number, fromY: number, toX: number, toY: number, profile?: Partial<SimulationProfile>): Promise<void> {
    const p = { ...this.profile, ...profile };

    const distance = Math.hypot(toX - fromX, toY - fromY);
    if (distance < 1) return;

    // Simple linear interpolation for usability
    const steps = Math.min(20, Math.max(5, Math.ceil(distance / 10)));
    const dt = 1 / 60;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const x = fromX + (toX - fromX) * progress;
      const y = fromY + (toY - fromY) * progress;

      this.dispatchMouseEvent('mousemove', x, y, 0);
      await this.sleep(16);
    }
  }

  private dispatchMouseEvent(type: string, x: number, y: number, button: number) {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button,
      buttons: type === 'mousedown' ? 1 : type === 'mouseup' ? 0 : 0,
      bubbles: true,
      cancelable: true,
      view: window,
      // NOTE: isTrusted will be false - this is content script fallback
      // For trusted events, use bridge via CDP Input API
    });

    const target = document.elementFromPoint(x, y) || document.body;
    target.dispatchEvent(event);
  }

  private dispatchKeyEvent(type: string, key: string) {
    const keyMap: Record<string, { key: string; code: string }> = {
      'Backspace': { key: 'Backspace', code: 'Backspace' },
      'Enter': { key: 'Enter', code: 'Enter' },
      'Tab': { key: 'Tab', code: 'Tab' },
      ' ': { key: ' ', code: 'Space' },
    };

    const mapping = keyMap[key] || { key: key.toUpperCase(), code: `Key${key.toUpperCase()}` };

    const event = new KeyboardEvent(type, {
      key: mapping.key,
      code: mapping.code,
      bubbles: true,
      cancelable: true,
    });

    (document.activeElement || document.body).dispatchEvent(event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const humanInput = new HumanInputSimulator();
(window as any).__humanInput = humanInput;