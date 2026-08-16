use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use reqwest::Client;

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
        if model.starts_with("claude") {
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
        if model.starts_with("claude") {
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
        let mut stream = resp.bytes_stream();

        use futures::StreamExt;
        let mut buffer = Vec::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);

            // Try to parse complete JSON objects from buffer
            while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                let line = buffer.drain(..=pos).collect::<Vec<_>>();
                let line_str = String::from_utf8_lossy(&line).trim().to_string();

                if line_str.is_empty() { continue; }

                if let Ok(resp) = serde_json::from_str::<OllamaResponse>(&line_str) {
                    let _ = tx.send(serde_json::json!({
                        "content": resp.message.content,
                        "tool_calls": resp.message.tool_calls,
                        "done": resp.done,
                    })).await;

                    if resp.done { return Ok(()); }
                }
            }
        }

        Ok(())
    }

    async fn complete_anthropic(&self, model: &str, messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>) -> Result<Value> {
        let key = self.anthropic_key.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Anthropic API key not set"))?;

        let anthropic_messages = messages.into_iter().map(|m| AnthropicMessage {
            role: m.role,
            content: if m.tool_calls.is_some() {
                serde_json::to_value(m.tool_calls)?
            } else {
                serde_json::json!([{ "type": "text", "text": m.content }])
            },
        }).collect();

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

        let anthropic_messages = messages.into_iter().map(|m| AnthropicMessage {
            role: m.role,
            content: if m.tool_calls.is_some() {
                serde_json::to_value(m.tool_calls)?
            } else {
                serde_json::json!([{ "type": "text", "text": m.content }])
            },
        }).collect();

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

        let mut stream = resp.bytes_stream();
        let mut buffer = Vec::new();

        use futures::StreamExt;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);

            while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                let line = buffer.drain(..=pos).collect::<Vec<_>>();
                let line_str = String::from_utf8_lossy(&line).trim().to_string();

                if !line_str.starts_with("data: ") { continue; }
                let data = &line_str[6..];
                if data == "[DONE]" { break; }

                if let Ok(event) = serde_json::from_str::<AnthropicStreamEvent>(data) {
                    match event.r#type.as_str() {
                        "content_block_delta" => {
                            if let Some(delta) = event.delta {
                                if let Some(text) = delta.text {
                                    let _ = tx.send(serde_json::json!({ "content": text, "done": false })).await;
                                }
                                if let Some(partial) = delta.partial_json {
                                    let _ = tx.send(serde_json::json!({ "tool_call_delta": partial, "done": false })).await;
                                }
                            }
                        }
                        "message_stop" => {
                            let _ = tx.send(serde_json::json!({ "done": true })).await;
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }

        Ok(())
    }
}