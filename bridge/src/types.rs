use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    pub session_id: String,
    pub goal: String,
    pub plan: Option<Plan>,
    pub current_step: usize,
    pub history: Vec<ExecutionStep>,
    pub dom_cache: std::collections::HashMap<String, CompressedDom>,
    pub variables: std::collections::HashMap<String, serde_json::Value>,
    pub checkpoints: Vec<Checkpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub goal: String,
    pub steps: Vec<PlanStep>,
    pub contingencies: std::collections::HashMap<String, Vec<PlanStep>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub action: ToolCall,
    pub expected_outcome: String,
    pub verification: VerificationRule,
    pub on_failure: FailureAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VerificationRule {
    ElementVisible(String), // selector
    ElementHidden(String),
    TextContains(String, String), // selector, text
    UrlMatches(String), // regex
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FailureAction {
    Retry,
    Fallback(String), // alternative step ID
    Escalate,
    Abort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionStep {
    pub step_id: String,
    pub action: ToolCall,
    pub result: ToolResult,
    pub timestamp: i64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub arguments: serde_json::Value,
    /// Optional ref_id for stable element targeting (perception upgrade)
    #[serde(default)]
    pub ref_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub data: Option<serde_json::Value>,
    pub error: Option<String>,
    pub summary: String,
    /// The wire format uses camelCase (`navigationOccurred`).
    #[serde(rename = "navigationOccurred")]
    pub navigation_occurred: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub step_index: usize,
    pub state_snapshot: serde_json::Value,
    pub wal_position: u64,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedDom {
    pub url: String,
    pub title: String,
    pub actions: Vec<ActionableElement>,
    pub summary: String,
    pub layout: LayoutNode,
    pub timestamp: i64,
    /// Optional Markdown content from Readability+Turndown (perception upgrade)
    #[serde(default)]
    pub markdown_content: Option<String>,
    /// Optional selector → ref_id mapping for stable element targeting
    #[serde(default)]
    pub ref_id_map: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionableElement {
    pub selector: String,
    pub tag: String,
    pub role: String,
    pub label: String,
    pub bounds: DomRect,
    pub actionability_score: f32,
    pub backend_node_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutNode {
    pub role: String,
    pub bounds: DomRect,
    pub children: Vec<LayoutNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskQueueEntry {
    pub id: String,
    pub r#type: TaskType,
    pub payload: serde_json::Value,
    pub priority: i32,
    pub deadline: i64,
    pub retry_policy: RetryPolicy,
    pub attempts: u32,
    pub status: TaskStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskType {
    ApiCall,
    DomAction,
    Navigation,
    Extraction,
    Wait,
    Decision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub backoff_multiplier: f64,
    pub retryable_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Dead,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub id: u64,
    pub timestamp: i64,
    pub operation: WalOperation,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WalOperation {
    StateUpdate,
    ActionExecuted,
    CheckpointCreated,
    TaskQueued,
    TaskCompleted,
    TaskFailed,
}

/// Observation payload submitted by the extension after local perception.
/// Contains the compressed DOM, Markdown content, and ref_id mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObservationSubmit {
    pub session_id: String,
    pub origin: String,
    pub dom: CompressedDom,
    /// Added after v0.1: an older counterpart may omit these, so they default.
    #[serde(default)]
    pub markdown_content: String,
    #[serde(default)]
    pub ref_id_map: std::collections::HashMap<String, String>,
    pub page_revision: u64,
}