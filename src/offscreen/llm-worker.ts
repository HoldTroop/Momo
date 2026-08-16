// LLM Worker - Runs in offscreen document for local inference
// This can use WebLLM, Transformers.js, or proxy to bridge

interface WorkerMessage {
  type: 'COMPLETE' | 'STREAM';
  payload: any;
  requestId: string;
}

interface WorkerResponse {
  type: 'LLM_CHUNK' | 'LLM_COMPLETE' | 'LLM_ERROR';
  chunk?: any;
  result?: any;
  error?: string;
  requestId: string;
}

// WebLLM integration (optional) - loaded via dynamic import to avoid build-time resolution
let webllmEngine: any = null;
let isWebllmLoaded = false;

// Use a function to defer the import until runtime
// Vite won't statically analyze this dynamic import with computed string
async function loadWebllmModule(): Promise<any> {
  const moduleName = '@mlc-ai/web-llm';
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import(moduleName);
  return mod;
}

async function initWebllm() {
  try {
    // Dynamic import to avoid loading if not available
    const { CreateMLCEngine } = await loadWebllmModule();
    webllmEngine = await CreateMLCEngine('Llama-3.2-3B-Instruct-q4f32_1-MLC', {
      initProgressCallback: (progress: any) => {
        self.postMessage({ type: 'LLM_CHUNK', chunk: { progress }, requestId: 'init' });
      },
    });
    isWebllmLoaded = true;
    console.log('[LLM Worker] WebLLM initialized');
  } catch (e) {
    console.log('[LLM Worker] WebLLM not available:', e);
    isWebllmLoaded = false;
  }
}

async function completeWithWebllm(messages: any[], tools: any[]) {
  if (!webllmEngine) throw new Error('WebLLM not initialized');

  const response = await webllmEngine.chat.completions.create({
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 2048,
  });

  return {
    content: response.choices[0].message.content || '',
    tool_calls: response.choices[0].message.tool_calls,
  };
}

async function completeViaBridge(payload: any) {
  // Proxy to bridge via service worker
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      if (e.data.type === 'BRIDGE_RESPONSE') {
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.payload);
      }
    };

    chrome.runtime.sendMessage({
      type: 'BRIDGE_REQUEST',
      payload,
    }, [channel.port2]);
  });
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, payload, requestId } = e.data;

  try {
    if (type === 'COMPLETE') {
      let result;

      if (isWebllmLoaded && payload.model?.includes('webllm')) {
        result = await completeWithWebllm(payload.messages, payload.tools || []);
      } else {
        result = await completeViaBridge({ type: 'LLM_COMPLETE', payload });
      }

      self.postMessage({ type: 'LLM_COMPLETE', result, requestId } as WorkerResponse);
    }
  } catch (error) {
    self.postMessage({ type: 'LLM_ERROR', error: String(error), requestId } as WorkerResponse);
  }
};

// Initialize WebLLM on startup
initWebllm();

console.log('[LLM Worker] Ready');