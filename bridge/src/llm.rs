use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use reqwest::Client;

const MAX_LINE_BYTES: usize = 1024 * 1024;

fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('\u{2026}');
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub r#type: String,
    pub function: ToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaOptions {
    temperature: f32,
    top_p: f32,
    num_predict: i32,
    num_ctx: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OllamaResponse {
    model: String,
    created_at: String,
    message: ChatMessage,
    done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicRequest {
    model: String,
    messages: Vec<AnthropicMessage>,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<AnthropicTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicMessage {
    role: String,
    content: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicTool {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicResponse {
    id: String,
    r#type: String,
    role: String,
    content: Vec<AnthropicContent>,
    model: String,
    stop_reason: Option<String>,
    stop_sequence: Option<String>,
    usage: AnthropicUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicContent {
    r#type: String,
    text: Option<String>,
    id: Option<String>,
    name: Option<String>,
    input: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicStreamEvent {
    r#type: String,
    index: Option<u32>,
    delta: Option<AnthropicDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_block: Option<AnthropicContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AnthropicError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicError {
    r#type: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AnthropicDelta {
    r#type: Option<String>,
    text: Option<String>,
    partial_json: Option<String>,
}

pub struct LlmGateway {
    client: Client,
    ollama_url: String,
    anthropic_key: Option<String>,
    available_models: Vec<String>,
}

impl LlmGateway {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?;

        let ollama_url = std::env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".to_string());
        let anthropic_key = std::env::var("ANTHROPIC_API_KEY").ok();

        let mut models = vec!["llama3.2:3b".to_string(), "llama3.2:1b".to_string()];
        if anthropic_key.is_some() {
            models.extend(vec!["claude-3-5-sonnet-20241022".to_string(), "claude-3-5-haiku-20241022".to_string()]);
        }

        Ok(Self {
            client,
            ollama_url,
            anthropic_key,
            available_models: models,
        })
    }

    pub fn available_models(&self) -> Vec<String> {
        self.available_models.clone()
    }

    pub async fn complete(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>) -> Result<Value> {
        if is_anthropic_model(model) {
            self.complete_anthropic(model, messages, tools).await
        } else {
            self.complete_ollama(model, messages, tools, false).await
        }
    }

    pub async fn stream_complete(
        &self,
        model: &str,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Tool>>,
        tx: mpsc::Sender<Value>,
    ) -> Result<()> {
        if is_anthropic_model(model) {
            self.stream_anthropic(model, messages, tools, tx).await
        } else {
            self.stream_ollama(model, messages, tools, tx).await
        }
    }

    async fn complete_ollama(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>, stream: bool) -> Result<Value> {
        let url = format!("{}/api/chat", self.ollama_url);
        let request = OllamaRequest {
            model: model.to_string(),
            messages,
            tools,
            stream,
            options: Some(OllamaOptions {
                temperature: 0.3,
                top_p: 0.9,
                num_predict: 4096,
                num_ctx: 32768,
            }),
        };

        let resp = self.client.post(&url).json(&request).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("LLM HTTP {status}: {}", truncate(&body, 500)));
        }
        let response: OllamaResponse = resp.json().await?;

        Ok(serde_json::json!({
            "content": response.message.content,
            "tool_calls": response.message.tool_calls,
            "model": response.model,
            "done": response.done,
        }))
    }

    async fn stream_ollama(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>, tx: mpsc::Sender<Value>) -> Result<()> {
        let url = format!("{}/api/chat", self.ollama_url);
        let request = OllamaRequest {
            model: model.to_string(),
            messages,
            tools,
            stream: true,
            options: Some(OllamaOptions {
                temperature: 0.3,
                top_p: 0.9,
                num_predict: 4096,
                num_ctx: 32768,
            }),
        };

        let resp = self.client.post(&url).json(&request).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("LLM HTTP {status}: {}", truncate(&body, 500)));
        }
        let mut stream = resp.bytes_stream();

        use futures::StreamExt;
        let mut buffer = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);

            // Try to parse complete JSON objects from buffer
            while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                if pos > MAX_LINE_BYTES {
                    return Err(anyhow::anyhow!("Ollama stream line exceeds {} byte limit", MAX_LINE_BYTES));
                }
                let line = buffer.drain(..=pos).collect::<Vec<_>>();
                if process_ollama_line(&tx, &line).await? {
                    return Ok(());
                }
            }

            if buffer.len() > MAX_LINE_BYTES {
                return Err(anyhow::anyhow!("Ollama stream line exceeds {} byte limit", MAX_LINE_BYTES));
            }
        }

        // L4: process a trailing partial line (no trailing newline)
        if !buffer.iter().all(|b| b.is_ascii_whitespace()) {
            if process_ollama_line(&tx, &buffer).await? {
                return Ok(());
            }
        }

        Ok(())
    }

    async fn complete_anthropic(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>) -> Result<Value> {
        let key = self.anthropic_key.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Anthropic API key not set"))?;

        let anthropic_messages = to_anthropic_messages(messages);

        let anthropic_tools = tools.map(|t| t.into_iter().map(|tool| AnthropicTool {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
        }).collect());

        let request = AnthropicRequest {
            model: model.to_string(),
            messages: anthropic_messages,
            max_tokens: 4096,
            tools: anthropic_tools,
            system: Some("You are an autonomous browser agent. Use tools to interact with web pages. Be precise and deliberate.".to_string()),
            stream: false,
        };

        let resp = self.client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("LLM HTTP {status}: {}", truncate(&body, 500)));
        }

        let response: AnthropicResponse = resp.json().await?;

        let mut content = String::new();
        let mut tool_calls = Vec::new();

        for c in response.content {
            match c.r#type.as_str() {
                "text" => content.push_str(c.text.as_deref().unwrap_or("")),
                "tool_use" => {
                    tool_calls.push(ToolCall {
                        id: c.id.unwrap_or_default(),
                        function: ToolFunction {
                            name: c.name.unwrap_or_default(),
                            arguments: serde_json::to_string(&c.input.unwrap_or(serde_json::json!({})))?,
                        }
                    });
                }
                _ => {}
            }
        }

        Ok(serde_json::json!({
            "content": content,
            "tool_calls": if tool_calls.is_empty() { None } else { Some(tool_calls) },
            "model": response.model,
            "done": true,
        }))
    }

    async fn stream_anthropic(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>, tx: mpsc::Sender<Value>) -> Result<()> {
        let key = self.anthropic_key.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Anthropic API key not set"))?;

        let anthropic_messages = to_anthropic_messages(messages);

        let anthropic_tools = tools.map(|t| t.into_iter().map(|tool| AnthropicTool {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
        }).collect());

        let request = AnthropicRequest {
            model: model.to_string(),
            messages: anthropic_messages,
            max_tokens: 4096,
            tools: anthropic_tools,
            system: Some("You are an autonomous browser agent. Use tools to interact with web pages. Be precise and deliberate.".to_string()),
            stream: true,
        };

        let resp = self.client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("LLM HTTP {status}: {}", truncate(&body, 500)));
        }

        let mut stream = resp.bytes_stream();
        let mut buffer = Vec::new();
        let mut tool_blocks: std::collections::HashMap<u32, (String, String)> = std::collections::HashMap::new();

        use futures::StreamExt;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);

            while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                if pos > MAX_LINE_BYTES {
                    return Err(anyhow::anyhow!("Anthropic stream line exceeds {} byte limit", MAX_LINE_BYTES));
                }
                let line = buffer.drain(..=pos).collect::<Vec<_>>();
                if process_anthropic_line(&tx, &mut tool_blocks, &line).await? {
                    return Ok(());
                }
            }

            if buffer.len() > MAX_LINE_BYTES {
                return Err(anyhow::anyhow!("Anthropic stream line exceeds {} byte limit", MAX_LINE_BYTES));
            }
        }

        // L4: process a trailing partial line (no trailing newline)
        if !buffer.iter().all(|b| b.is_ascii_whitespace()) {
            if process_anthropic_line(&tx, &mut tool_blocks, &buffer).await? {
                return Ok(());
            }
        }

        Ok(())
    }
}

fn is_anthropic_model(model: &str) -> bool {
    model.to_lowercase().starts_with("claude")
}

fn to_anthropic_messages(messages: Vec<ChatMessage>) -> Vec<AnthropicMessage> {
    messages.into_iter().map(|m| {
        if let Some(tool_calls) = m.tool_calls {
            let blocks: Vec<Value> = tool_calls.into_iter().map(|tc| {
                let input = serde_json::from_str::<Value>(&tc.function.arguments).unwrap_or(Value::Null);
                serde_json::json!({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.function.name,
                    "input": input,
                })
            }).collect();
            AnthropicMessage { role: m.role, content: Value::Array(blocks) }
        } else if m.role == "tool" {
            AnthropicMessage {
                role: "user".to_string(),
                content: serde_json::json!([{
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.unwrap_or_default(),
                    "content": m.content,
                }]),
            }
        } else {
            AnthropicMessage {
                role: m.role,
                content: serde_json::json!([{ "type": "text", "text": m.content }]),
            }
        }
    }).collect()
}

async fn process_ollama_line(tx: &mpsc::Sender<Value>, line: &[u8]) -> Result<bool> {
    let line_str = String::from_utf8_lossy(line).trim().to_string();

    if line_str.is_empty() { return Ok(false); }

    if let Ok(resp) = serde_json::from_str::<OllamaResponse>(&line_str) {
        let _ = tx.send(serde_json::json!({
            "content": resp.message.content,
            "tool_calls": resp.message.tool_calls,
            "done": resp.done,
        })).await;

        return Ok(resp.done);
    }

    if let Ok(v) = serde_json::from_str::<Value>(&line_str) {
        if let Some(err) = v.get("error") {
            if !err.is_null() {
                let msg = err.as_str().map(|s| s.to_string()).unwrap_or_else(|| err.to_string());
                return Err(anyhow::anyhow!("Ollama stream error: {msg}"));
            }
        }
    }

    Ok(false)
}

async fn process_anthropic_line(
    tx: &mpsc::Sender<Value>,
    tool_blocks: &mut std::collections::HashMap<u32, (String, String)>,
    line: &[u8],
) -> Result<bool> {
    let line_str = String::from_utf8_lossy(line).trim().to_string();

    if !line_str.starts_with("data: ") { return Ok(false); }
    let data = &line_str[6..];

    if data == "[DONE]" {
        let _ = tx.send(serde_json::json!({ "done": true })).await;
        return Ok(true);
    }

    if let Ok(event) = serde_json::from_str::<AnthropicStreamEvent>(data) {
        match event.r#type.as_str() {
            "content_block_start" => {
                if let Some(cb) = event.content_block {
                    if cb.r#type == "tool_use" {
                        let index = event.index.unwrap_or(0);
                        tool_blocks.insert(index, (cb.id.unwrap_or_default(), cb.name.unwrap_or_default()));
                    }
                }
                Ok(false)
            }
            "content_block_delta" => {
                if let Some(delta) = event.delta {
                    if let Some(text) = delta.text {
                        let _ = tx.send(serde_json::json!({ "content": text, "done": false })).await;
                    }
                    if let Some(partial) = delta.partial_json {
                        let (id, name) = event.index
                            .and_then(|i| tool_blocks.get(&i))
                            .cloned()
                            .unwrap_or_default();
                        let _ = tx.send(serde_json::json!({
                            "tool_call_delta": partial,
                            "tool_call_id": id,
                            "tool_call_name": name,
                            "done": false,
                        })).await;
                    }
                }
                Ok(false)
            }
            "message_stop" => {
                let _ = tx.send(serde_json::json!({ "done": true })).await;
                Ok(true)
            }
            "error" => {
                let msg = event.error.as_ref()
                    .and_then(|e| e.message.clone())
                    .unwrap_or_else(|| "unknown error".to_string());
                Err(anyhow::anyhow!("Anthropic stream error: {msg}"))
            }
            _ => Ok(false),
        }
    } else if let Ok(v) = serde_json::from_str::<Value>(data) {
        if v.get("type").and_then(|t| t.as_str()) == Some("error") {
            let msg = v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            return Err(anyhow::anyhow!("Anthropic stream error: {msg}"));
        }
        Ok(false)
    } else {
        Ok(false)
    }
}
