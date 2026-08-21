import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlanStep } from '../sw/orchestrator.js';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  toolCalls?: any[];
  toolResults?: any[];
  timestamp: number;
}

interface Session {
  sessionId: string;
  goal: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  createdAt: number;
  updatedAt: number;
  stepCount: number;
}

interface AgentState {
  sessionId: string | null;
  goal: string;
  plan: PlanStep[] | null;
  currentStep: number;
  history: any[];
  isRunning: boolean;
}

const container = document.getElementById('root')!;
const root = createRoot(container);

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agentState, setAgentState] = useState<AgentState>({
    sessionId: null,
    goal: '',
    plan: null,
    currentStep: 0,
    history: [],
    isRunning: false,
  });
  const [showSessions, setShowSessions] = useState(false);
  const [bridgeToken, setBridgeToken] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [humanIntervention, setHumanIntervention] = useState<{ stepId: string; question: string; actionHash: string; pageRevision: number; origin: string; action: string; target: string; reversible: boolean; riskClass: string } | null>(null);
  const [streamMessageId, setStreamMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const handlePortMessageRef = useRef<(msg: any) => void>(() => {});
  const loadSessionsRef = useRef<() => void>(() => {});
  const runtimeListener = useRef((msg: any) => {
    handlePortMessageRef.current(msg);
  }).current;

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let unmounted = false;

    const connectPort = () => {
      const port = chrome.runtime.connect({ name: 'sidepanel' });
      portRef.current = port;

      port.onMessage.addListener((msg) => {
        reconnectAttempts = 0;
        handlePortMessageRef.current(msg);
      });

      port.onDisconnect.addListener(() => {
        if (import.meta.env.DEV) {
          console.log('[SidePanel] Disconnected from SW');
        }
        if (unmounted) return;
        reconnectAttempts += 1;
        if (reconnectAttempts >= 3) {
          window.location.reload();
          return;
        }
        portRef.current = null;
        reconnectTimer = setTimeout(connectPort, 2000);
      });
    };

    connectPort();

    // The service worker broadcasts lifecycle and confirmation events via
    // chrome.runtime.sendMessage (not the port), so listen there too.
    chrome.runtime.onMessage.addListener(runtimeListener);

    // Load sessions
    loadSessionsRef.current();

    return () => {
      unmounted = true;
      chrome.runtime.onMessage.removeListener(runtimeListener);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    chrome.storage.local.get('bridgeToken').then((v) => { if (typeof v?.bridgeToken === 'string') setBridgeToken(v.bridgeToken); }).catch((err) => console.warn('[Momo] Handled error:', err));
  }, []);

  useEffect(() => {
    const el = chatAreaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handlePortMessage = (msg: any) => {
    if (msg.type === 'EVENT') { handlePortMessage(msg.payload); return; }
    if (msg.type === 'RESPONSE') {
      const p = msg.payload;
      if (p?.error) { setIsLoading(false); addMessage({ role: 'agent', content: `❌ Error: ${p.error}` }); return; }
      if (p && typeof p === 'object') { handlePortMessage(p); return; }
      return;
    }

    switch (msg.type) {
      case 'STATE_UPDATE':
        if (msg.payload?.state) {
          setAgentState(prev => ({ ...prev, ...msg.payload.state, isRunning: msg.payload.state.isRunning ?? prev.isRunning }));
        }
        break;
      case 'TASK_STARTED':
        setIsLoading(false);
        addMessage({ role: 'agent', content: `▶ Task started: ${msg.payload.goal}` });
        break;
      case 'PLAN_CREATED':
        setAgentState(prev => ({ ...prev, plan: msg.payload.plan, currentStep: 0 }));
        break;
      case 'STEP_STARTED':
        setIsLoading(false);
        setAgentState(prev => ({ ...prev, currentStep: msg.payload.stepIndex }));
        addMessage({ role: 'agent', content: `Step ${msg.payload.stepIndex + 1}: ${msg.payload.action.name}`, toolCalls: [msg.payload.action] });
        break;
      case 'STEP_COMPLETED':
        updateLastAgentMessage(msg.payload.result);
        break;
      case 'TASK_COMPLETED':
        addMessage({ role: 'agent', content: '✅ Task completed successfully!' });
        setIsLoading(false);
        loadSessions();
        break;
      case 'TASK_ABORTED':
        addMessage({ role: 'agent', content: `❌ Task aborted: ${msg.payload.reason}` });
        setIsLoading(false);
        break;
      case 'HUMAN_INTERVENTION_REQUIRED':
        setHumanIntervention({
          stepId: msg.payload.stepId,
          question: msg.payload.error || `Step ${msg.payload.stepId} requires confirmation`,
          actionHash: msg.payload.actionHash,
          pageRevision: msg.payload.pageRevision,
          origin: msg.payload.origin,
          action: msg.payload.action,
          target: msg.payload.target,
          reversible: msg.payload.reversible,
          riskClass: msg.payload.riskClass,
        });
        break;
      case 'LLM_STREAM_CHUNK':
        appendToStream(msg.payload.content);
        break;
      case 'BRIDGE_EVENT':
        if (msg.payload?.event === 'llm_stream_chunk') {
          const chunk = msg.payload.data?.chunk;
          const text = typeof chunk === 'string' ? chunk : chunk?.delta ?? chunk?.text ?? '';
          if (text) appendToStream(text);
        } else if (msg.payload?.event === 'llm_stream_end') {
          finalizeStream();
        }
        break;
    }
  };

  const loadSessions = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SESSIONS' });
      if (response?.sessions) {
        setSessions(response.sessions);
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  };

  handlePortMessageRef.current = handlePortMessage;
  loadSessionsRef.current = loadSessions;

  const sendToSw = (type: string, payload: any) => {
    if (portRef.current) {
      portRef.current.postMessage({ type, payload });
    }
  };

  const addMessage = (msg: Omit<Message, 'id' | 'timestamp'>) => {
    const newMessage: Message = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, newMessage]);
  };

  const updateLastAgentMessage = (result: any) => {
    setMessages(prev => {
      const idx = prev.findLastIndex(m => m.role === 'agent');
      if (idx === -1) return prev;
      const updated = [...prev];
      const current = updated[idx];
      if (!current) return prev;
      updated[idx] = {
        ...current,
        toolResults: [...(current.toolResults || []), result],
        content: current.content + `\n\n**Result:** ${result.summary}`,
      };
      return updated;
    });
  };

  const appendToStream = (text: string) => {
    if (streamMessageId) {
      setMessages(prev => prev.map(m => m.id === streamMessageId ? { ...m, content: m.content + text } : m));
    } else {
      const newMessage: Message = {
        id: crypto.randomUUID(),
        role: 'agent',
        content: text,
        timestamp: Date.now(),
      };
      setStreamMessageId(newMessage.id);
      setMessages(prev => [...prev, newMessage]);
    }
  };

  const finalizeStream = () => {
    setStreamMessageId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userInput = input;
    setInput('');
    setIsLoading(true);

    addMessage({ role: 'user', content: userInput });

    if (!sessionId) {
      // Start new task
      sendToSw('START_TASK', { goal: userInput });
      addMessage({ role: 'agent', content: '▶ Task started — this build has no local planner; drive it via MCP tools, or press Stop.' });
    } else {
      // Continue existing task (not fully implemented)
      sendToSw('EXECUTE_TOOL', { name: 'observe', arguments: {} });
    }
  };

  const handleHumanResponse = (action: 'confirm' | 'deny' | 'takeover') => {
    if (!humanIntervention) return;
    sendToSw('HUMAN_RESPONSE', {
      action,
      actionHash: humanIntervention.actionHash,
      pageRevision: humanIntervention.pageRevision,
    });
    setHumanIntervention(null);
  };

  const handleStopTask = () => {
    if (portRef.current) {
      portRef.current.postMessage({ type: 'STOP_TASK', payload: {} });
    } else {
      chrome.runtime.sendMessage({ type: 'STOP_TASK', payload: {} }).catch((err) => console.warn('[Momo] Handled error:', err));
    }
  };

  const handleNewTask = () => {
    if (portRef.current) {
      portRef.current.postMessage({ type: 'STOP_TASK', payload: {} });
    } else {
      chrome.runtime.sendMessage({ type: 'STOP_TASK', payload: {} }).catch((err) => console.warn('[Momo] Handled error:', err));
    }
    setSessionId(null);
    setMessages([]);
    setIsLoading(false);
    setHumanIntervention(null);
    setAgentState({ sessionId: null, goal: '', plan: null, currentStep: 0, history: [], isRunning: false });
  };

  const handleSessionClick = (session: Session) => {
    portRef.current?.postMessage({ type: 'RESUME_TASK', payload: { sessionId: session.sessionId } });
    setSessionId(session.sessionId);
    setShowSessions(false);
    addMessage({ role: 'agent', content: `Resuming session ${session.sessionId}...` });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header className="header">
        <h1>🤖 Autonomous Agent</h1>
        <span className={`status-badge ${agentState.isRunning ? 'running' : 'idle'}`}>
          {agentState.isRunning ? 'Running' : 'Idle'}
        </span>
        <button className="btn secondary" onClick={handleNewTask} style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: '12px' }}>
          New Task
        </button>
        <button className="btn secondary" onClick={() => setShowSessions(!showSessions)} style={{ padding: '6px 12px', fontSize: '12px' }}>
          {showSessions ? 'Hide' : 'Sessions'}
        </button>
      </header>

      <div className="chat-area" ref={chatAreaRef}>
        {agentState.plan && agentState.plan.length > 0 && (
          <div className="plan-view">
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>📋 Plan ({agentState.currentStep + 1}/{agentState.plan.length})</div>
            {agentState.plan.map((step, idx) => (
              <div key={step.id} className={`plan-step ${idx === agentState.currentStep ? 'current' : idx < agentState.currentStep ? 'done' : ''}`}>
                <div className={`step-number ${idx === agentState.currentStep ? 'current' : idx < agentState.currentStep ? 'done' : ''}`}>
                  {idx + 1}
                </div>
                <div className="step-info">
                  <div className="step-action">🔧 {step.action.name}</div>
                  <div className="step-details">
                    {step.expectedOutcome}
                    {idx === agentState.currentStep && ' • Running...'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {messages.length === 0 && !agentState.isRunning && (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <p>Describe a task to begin</p>
            <p style={{ fontSize: '12px', marginTop: '8px' }}>Example: "Log into GitHub and create a new repository"</p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className={`avatar ${msg.role}`}>
              {msg.role === 'agent' ? '🤖' : '👤'}
            </div>
            <div className="message-content">
              {msg.content}
              {msg.toolCalls?.map((tc, i) => (
                <div key={i} className="tool-call">
                  <div className="name">🔧 {tc.name}</div>
                  <div className="args">{JSON.stringify(tc.arguments, null, 2)}</div>
                </div>
              ))}
              {msg.toolResults?.map((tr, i) => (
                <div key={i} className={`tool-result ${tr.success ? '' : 'error'}`}>
                  <div>{tr.success ? '✅' : '❌'} {tr.summary}</div>
                  {tr.data && <pre>{JSON.stringify(tr.data, null, 2)}</pre>}
                  {tr.error && <div style={{ color: '#f85149' }}>{tr.error}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="message agent">
            <div className="avatar agent">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {humanIntervention && (
        <div style={{ padding: '16px', borderTop: '1px solid #30363d', background: '#4d1a1a' }}>
          <div style={{ color: '#f85149', fontWeight: 600, marginBottom: '8px' }}>⚠️ Human Intervention Required</div>
          <div style={{ marginBottom: '8px', fontSize: '12px', opacity: 0.8 }}>
            Action: <strong>{humanIntervention.action}</strong> on <strong>{humanIntervention.target}</strong> at {humanIntervention.origin}
            {' • '}Risk: {humanIntervention.riskClass} {' • '}{humanIntervention.reversible ? ' Reversible' : ' Irreversible'}
          </div>
          <div style={{ marginBottom: '12px' }}>{humanIntervention.question}</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn primary" onClick={() => handleHumanResponse('confirm')}>✅ Confirm</button>
            <button className="btn secondary" onClick={() => handleHumanResponse('deny')}>❌ Deny</button>
            <button className="btn danger" onClick={() => handleHumanResponse('takeover')}>🛑 Take Over</button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="input-area">
        <div className="input-row">
          <textarea
            className="input-field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={agentState.isRunning ? 'Task running...' : 'Describe your task...'}
            disabled={isLoading}
            rows={1}
          />
          <button className="btn primary" type="submit" disabled={isLoading || !input.trim()}>
            {isLoading ? 'Running...' : 'Send'}
          </button>
          <button
            className="btn danger"
            type="button"
            onClick={handleStopTask}
            disabled={!isLoading && !agentState.isRunning}
          >
            Stop
          </button>
        </div>
      </form>

      <div style={{ padding: '0 16px 12px' }}>
        <button className="btn secondary" onClick={() => setShowSettings(!showSettings)} style={{ padding: '6px 12px', fontSize: '12px' }}>
          Bridge settings
        </button>
        {showSettings && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="password"
              className="input-field"
              style={{ minHeight: 'auto', maxHeight: 'none' }}
              value={bridgeToken}
              onChange={(e) => setBridgeToken(e.target.value)}
              placeholder="Bridge auth token"
            />
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="btn primary"
                style={{ padding: '6px 12px', fontSize: '12px' }}
                onClick={() => {
                  chrome.storage.local.set({ bridgeToken: bridgeToken.trim() }).catch((e) => console.error('Failed to save bridge token:', e));
                }}
              >
                Save token
              </button>
              <span style={{ fontSize: '11px', color: '#8b949e' }}>
                Paste the token from ~/.momo/auth_token (printed by the bridge on first start).
              </span>
            </div>
          </div>
        )}
      </div>

      {showSessions && sessions.length > 0 && (
        <div className="session-list">
          <div style={{ fontWeight: 600, marginBottom: '12px' }}>Recent Sessions</div>
          {sessions.map(session => (
            <div key={session.sessionId} className="session-item" onClick={() => handleSessionClick(session)}>
              <div className="session-info">
                <span className="session-goal">{session.goal.slice(0, 60)}{session.goal.length > 60 ? '...' : ''}</span>
                <span className="session-meta">
                  {new Date(session.createdAt).toLocaleString()} • {session.stepCount} steps • {session.status}
                </span>
              </div>
              <span className={`status-badge ${session.status === 'running' ? 'running' : session.status === 'completed' ? 'idle' : 'error'}`}>
                {session.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {showSessions && sessions.length === 0 && (
        <div className="session-list">
          <div className="empty-state" style={{ padding: '20px' }}>
            <p>No previous sessions</p>
          </div>
        </div>
      )}
    </div>
  );
}

root.render(<App />);