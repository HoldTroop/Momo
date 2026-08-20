// Typed shims for the perception globals that src/content/perception.ts injects
// onto `window` at content-script runtime. The tool layer (src/lib/tools/) and
// the message router reference these from inside `chrome.scripting.executeScript`
// `func:` closures, which previously had to suppress the missing-declaration
// errors with `@ts-ignore`. Centralizing the augmentation here — a dedicated
// ambient module — makes the declarations visible to every module in the program
// without burying them inside a content-script source file.
import type { PerceptionResult, InteractiveElementsResult, RefResolution } from './content/perception.js';

declare global {
  interface Window {
    __perceptionExtract: (includeMarkdown: boolean) => PerceptionResult;
    __perceptionFindByRefId: (refId: string) => HTMLElement | null;
    __perceptionResolveSelector: (selector: string) => { x: number; y: number; element: HTMLElement } | null;
    __perceptionResolveTarget: (refId: string | undefined, selector: string | undefined) => { x: number; y: number; element: HTMLElement } | null;
    __perceptionGetInteractiveElements: () => InteractiveElementsResult;
    __perceptionResolveByRefStrict: (ref: string) => RefResolution;
  }
}

export {};
