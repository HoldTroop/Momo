// Minimal Automation Hygiene — Policy-Compliant
// Per Architecture Blueprint Section 7: only standard automation hygiene, no evasion
// "The correct success metric is not 'undetected'; it is 'authorized, explainable, reversible, and reliable.'"

export function initAutomationHygiene(): void {
  // Standard automation hygiene: hide webdriver flag
  // This is the ONLY fingerprint modification permitted per Blueprint
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  console.log('[Automation Hygiene] Applied: navigator.webdriver = undefined');
}

// Auto-initialize when loaded in content script context
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initAutomationHygiene();
}