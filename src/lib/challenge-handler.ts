// Challenge Handler - Detects and handles CAPTCHAs, Cloudflare challenges, etc.

interface ChallengeInfo {
  type: 'turnstile' | 'hcaptcha' | 'recaptcha' | 'cloudflare' | 'unknown';
  selector: string;
  sitekey?: string;
  action?: string;
}

class ChallengeHandler {
  private knownSelectors = {
    turnstile: ['iframe[src*="challenges.cloudflare.com"]', '.cf-turnstile', '[data-sitekey][data-callback*="turnstile"]'],
    hcaptcha: ['iframe[src*="hcaptcha.com"]', '.h-captcha', '[data-sitekey][data-hcaptcha-widget-id]'],
    recaptcha: ['iframe[src*="recaptcha.net"]', '.g-recaptcha', '[data-sitekey][data-callback*="recaptcha"]'],
    cloudflare: ['#challenge-form', '.challenge-page', 'form[id*="challenge"]', '.cf-browser-verification'],
  };

  constructor() {
    this.init();
  }

  private init() {
    // Observe for challenge appearance
    const observer = new MutationObserver(() => this.scanForChallenges());
    observer.observe(document.body, { childList: true, subtree: true });

    // Periodic scan
    setInterval(() => this.scanForChallenges(), 5000);

    // Listen for messages
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SCAN_CHALLENGES') {
        this.scanForChallenges().then(challenges => sendResponse({ challenges }));
      }
      return true;
    });

    console.log('[Challenge Handler] Initialized');
  }

  async scanForChallenges(): Promise<ChallengeInfo[]> {
    const challenges: ChallengeInfo[] = [];

    for (const [type, selectors] of Object.entries(this.knownSelectors)) {
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const challenge: ChallengeInfo = {
            type: type as ChallengeInfo['type'],
            selector: this.getSelector(el),
            sitekey: el.getAttribute('data-sitekey') || undefined,
            action: el.getAttribute('data-action') || undefined,
          };
          challenges.push(challenge);
        }
      }
    }

    return challenges;
  }

  async solveChallenge(challenge: ChallengeInfo): Promise<boolean> {
    switch (challenge.type) {
      case 'turnstile':
        return await this.solveTurnstile(challenge);
      case 'hcaptcha':
        return await this.solveHcaptcha(challenge);
      case 'recaptcha':
        return await this.solveRecaptcha(challenge);
      case 'cloudflare':
        return await this.solveCloudflare(challenge);
      default:
        return false;
    }
  }

  private async solveTurnstile(challenge: ChallengeInfo): Promise<boolean> {
    try {
      // Try to find and click the checkbox
      const iframe = document.querySelector(challenge.selector) as HTMLIFrameElement;
      if (iframe) {
        // Wait for iframe to load
        await new Promise(resolve => {
          if (iframe.contentDocument?.readyState === 'complete') resolve(true);
          else iframe.onload = () => resolve(true);
        });

        const iframeDoc = iframe.contentDocument;
        const checkbox = iframeDoc?.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) {
          // Use human-like click
          await this.humanClickElement(checkbox);
          await new Promise(r => setTimeout(r, 2000));
          return !checkbox.checked; // If unchecked after click, likely solved
        }
      }
      return false;
    } catch (e) {
      console.warn('[Challenge Handler] Turnstile solve failed:', e);
      return false;
    }
  }

  private async solveHcaptcha(challenge: ChallengeInfo): Promise<boolean> {
    // hCaptcha typically requires image classification - escalate to human
    return false;
  }

  private async solveRecaptcha(challenge: ChallengeInfo): Promise<boolean> {
    // reCAPTCHA v3 is invisible, v2 requires image selection - escalate to human
    return false;
  }

  private async solveCloudflare(challenge: ChallengeInfo): Promise<boolean> {
    try {
      // Cloudflare challenge often auto-solves after JS execution
      const form = document.querySelector(challenge.selector) as HTMLFormElement;
      if (form) {
        // Check if there's a submit button
        const submit = form.querySelector('input[type="submit"], button[type="submit"]') as HTMLButtonElement;
        if (submit) {
          await this.humanClickElement(submit);
          await new Promise(r => setTimeout(r, 5000));
          return !document.querySelector(challenge.selector); // If form gone, solved
        }
      }
      return false;
    } catch (e) {
      console.warn('[Challenge Handler] Cloudflare solve failed:', e);
      return false;
    }
  }

  private async humanClickElement(el: Element): Promise<void> {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 4;
    const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 4;

    // Dispatch mouse events
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    el.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, button: 0, bubbles: true }));
  }

  private getSelector(el: Element): string {
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
}

new ChallengeHandler();