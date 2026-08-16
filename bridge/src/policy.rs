// Policy Engine + Audit Log
// Per Architecture Blueprint Sections 5 & 7: JSON Schema validation, audit log, confirmation gates

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::{debug, info, warn};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    pub allowlist: Vec<String>,
    pub permitted_actions: Vec<String>,
    pub confirmation_policy: ConfirmationPolicy,
    pub data_retention: DataRetentionPolicy,
    pub token_budget: TokenBudgetPolicy,
    pub risk_thresholds: RiskThresholds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfirmationPolicy {
    Always,
    Sensitive,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataRetentionPolicy {
    Session,
    Persistent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenBudgetPolicy {
    pub max_tokens: u64,
    pub warning_threshold: f64,
    pub reset_interval_hours: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskThresholds {
    pub read: u64,
    pub write: u64,
    pub navigation: u64,
    pub payment: u64,
    pub auth: u64,
    pub dangerous: u64,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            allowlist: vec![],
            permitted_actions: vec![],
            confirmation_policy: ConfirmationPolicy::Sensitive,
            data_retention: DataRetentionPolicy::Session,
            token_budget: TokenBudgetPolicy {
                max_tokens: 100_000,
                warning_threshold: 0.8,
                reset_interval_hours: 24,
            },
            risk_thresholds: RiskThresholds {
                read: 1000,
                write: 500,
                navigation: 100,
                payment: 10,
                auth: 10,
                dangerous: 1,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: u64,
    pub timestamp: DateTime<Utc>,
    pub session_id: String,
    pub action: String,
    pub origin: String,
    pub target: String,
    pub arguments: Value,
    pub risk_class: RiskClass,
    pub outcome: AuditOutcome,
    pub action_hash: String,
    pub page_revision: u64,
    pub user_confirmed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskClass {
    Read,
    Write,
    Navigation,
    Payment,
    Auth,
    Dangerous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditOutcome {
    Success,
    Denied,
    Failed,
    Escalated,
    Confirmed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDecision {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub reason: Option<String>,
    pub risk_class: RiskClass,
    pub confirmation_data: Option<ConfirmationData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationData {
    pub origin: String,
    pub action: String,
    pub target: String,
    pub data: Value,
    pub reversible: bool,
    pub risk_class: RiskClass,
}

pub struct PolicyEngine {
    config: RwLock<PolicyConfig>,
    db: Arc<RwLock<Connection>>,
    token_usage: RwLock<u64>,
    last_reset: RwLock<DateTime<Utc>>,
}

impl PolicyEngine {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let db = Connection::open(&db_path)?;
        Self::init_schema(&db)?;

        Ok(Self {
            config: RwLock::new(PolicyConfig::default()),
            db: Arc::new(RwLock::new(db)),
            token_usage: RwLock::new(0),
            last_reset: RwLock::new(Utc::now()),
        })
    }

    fn init_schema(db: &Connection) -> Result<()> {
        db.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                action TEXT NOT NULL,
                origin TEXT NOT NULL,
                target TEXT NOT NULL,
                arguments TEXT NOT NULL,
                risk_class TEXT NOT NULL,
                outcome TEXT NOT NULL,
                action_hash TEXT NOT NULL,
                page_revision INTEGER NOT NULL,
                user_confirmed INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

            CREATE TABLE IF NOT EXISTS policy_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    pub fn load_config(&self) -> Result<()> {
        let db = self.db.read();
        let mut stmt = db.prepare("SELECT key, value FROM policy_config")?;
        let rows = stmt.query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })?;

        let mut config = self.config.write();
        for row in rows {
            let (key, value) = row?;
            match key.as_str() {
                "allowlist" => config.allowlist = serde_json::from_str(&value)?,
                "permitted_actions" => config.permitted_actions = serde_json::from_str(&value)?,
                "confirmation_policy" => config.confirmation_policy = serde_json::from_str(&value)?,
                "data_retention" => config.data_retention = serde_json::from_str(&value)?,
                "token_budget" => config.token_budget = serde_json::from_str(&value)?,
                "risk_thresholds" => config.risk_thresholds = serde_json::from_str(&value)?,
                _ => {}
            }
        }
        Ok(())
    }

    pub fn save_config(&self, config: &PolicyConfig) -> Result<()> {
        let db = self.db.write();
        let tx = db.transaction()?;

        let now = Utc::now().to_rfc3339();
        let pairs = vec![
            ("allowlist", serde_json::to_string(&config.allowlist)?),
            ("permitted_actions", serde_json::to_string(&config.permitted_actions)?),
            ("confirmation_policy", serde_json::to_string(&config.confirmation_policy)?),
            ("data_retention", serde_json::to_string(&config.data_retention)?),
            ("token_budget", serde_json::to_string(&config.token_budget)?),
            ("risk_thresholds", serde_json::to_string(&config.risk_thresholds)?),
        ];

        for (key, value) in pairs {
            tx.execute(
                "INSERT OR REPLACE INTO policy_config (key, value, updated_at) VALUES (?, ?, ?)",
                params![key, value, now],
            )?;
        }

        tx.commit()?;
        *self.config.write() = config.clone();
        Ok(())
    }

    pub fn check_allowlist(&self, url: &str) -> bool {
        let config = self.config.read();
        if config.allowlist.is_empty() {
            return true; // No allowlist = all allowed
        }
        let origin = match Url::parse(url) {
            Ok(u) => u.origin().ascii_serialization(),
            Err(_) => return false,
        };
        config.allowlist.iter().any(|allowed| {
            if allowed.starts_with("*.") {
                let domain = &allowed[2..];
                origin.ends_with(domain)
            } else {
                origin == *allowed
            }
        })
    }

    pub fn check_action_permitted(&self, action: &str) -> bool {
        let config = self.config.read();
        if config.permitted_actions.is_empty() {
            return true; // No restrictions
        }
        config.permitted_actions.contains(&action.to_string())
    }

    pub fn evaluate(&self, request: &PolicyRequest) -> Result<PolicyDecision> {
        let config = self.config.read();

        // Check allowlist for navigation
        if request.action == "navigate" {
            if let Some(url) = request.arguments.get("url").and_then(|v| v.as_str()) {
                if !self.check_allowlist(url) {
                    return Ok(PolicyDecision {
                        allowed: false,
                        requires_confirmation: false,
                        reason: Some(format!("Origin not on allowlist: {}", url)),
                        risk_class: RiskClass::Navigation,
                        confirmation_data: None,
                    });
                }
            }
        }

        // Check action permitted
        if !self.check_action_permitted(&request.action) {
            return Ok(PolicyDecision {
                allowed: false,
                requires_confirmation: false,
                reason: Some(format!("Action not permitted: {}", request.action)),
                risk_class: self.classify_risk(&request.action),
                confirmation_data: None,
            });
        }

        // Determine risk class
        let risk_class = self.classify_risk(&request.action);

        // Check token budget
        let tokens_needed = self.estimate_tokens(&request.action);
        if !self.check_token_budget(tokens_needed) {
            return Ok(PolicyDecision {
                allowed: false,
                requires_confirmation: false,
                reason: Some("Token budget exceeded".to_string()),
                risk_class: risk_class.clone(),
                confirmation_data: None,
            });
        }

        // Determine if confirmation needed
        let requires_confirmation = self.requires_confirmation(&config, &risk_class, request);
        let reversible = self.is_reversible(&request.action);

        let decision = PolicyDecision {
            allowed: true,
            requires_confirmation,
            reason: None,
            risk_class: risk_class.clone(),
            confirmation_data: if requires_confirmation {
                Some(ConfirmationData {
                    origin: request.origin.clone(),
                    action: request.action.clone(),
                    target: request.target.clone(),
                    data: request.arguments.clone(),
                    reversible,
                    risk_class: risk_class.clone(),
                })
            } else {
                None
            },
        };

        // Deduct tokens
        self.deduct_tokens(tokens_needed);

        Ok(decision)
    }

    fn classify_risk(&self, action: &str) -> RiskClass {
        match action {
            "navigate" => RiskClass::Navigation,
            "click" => RiskClass::Write,
            "type" => RiskClass::Write,
            "extract" => RiskClass::Read,
            "scroll" => RiskClass::Read,
            "wait" => RiskClass::Read,
            "observe" => RiskClass::Read,
            "human_click" => RiskClass::Write,
            "human_type" => RiskClass::Write,
            _ => RiskClass::Write,
        }
    }

    fn estimate_tokens(&self, action: &str) -> u64 {
        match action {
            "navigate" => 100,
            "click" => 10,
            "type" => 5,
            "extract" => 20,
            "scroll" => 1,
            "wait" => 5,
            "observe" => 50,
            "human_click" => 10,
            "human_type" => 5,
            _ => 10,
        }
    }

    fn check_token_budget(&self, tokens: u64) -> bool {
        let usage = *self.token_usage.read();
        let config = self.config.read();
        usage + tokens <= config.token_budget.max_tokens
    }

    fn deduct_tokens(&self, tokens: u64) {
        let mut usage = self.token_usage.write();
        *usage += tokens;
    }

    fn requires_confirmation(&self, config: &PolicyConfig, risk_class: &RiskClass, request: &PolicyRequest) -> bool {
        match config.confirmation_policy {
            ConfirmationPolicy::Always => true,
            ConfirmationPolicy::Never => false,
            ConfirmationPolicy::Sensitive => {
                matches!(risk_class, RiskClass::Payment | RiskClass::Auth | RiskClass::Dangerous)
                    || (request.action == "type" && self.is_sensitive_field(request))
            }
        }
    }

    fn is_sensitive_field(&self, request: &PolicyRequest) -> bool {
        // Check if selector targets password, credit card, or secret field
        if let Some(selector) = request.arguments.get("selector").and_then(|v| v.as_str()) {
            selector.to_lowercase().contains("password")
                || selector.to_lowercase().contains("secret")
                || selector.to_lowercase().contains("cc-")
                || selector.to_lowercase().contains("credit")
                || selector.to_lowercase().contains("cvv")
        } else {
            false
        }
    }

    fn is_reversible(&self, action: &str) -> bool {
        matches!(action, "navigate" | "scroll" | "wait" | "observe" | "extract")
    }

    pub fn log_audit(&self, entry: &AuditEntry) -> Result<()> {
        let db = self.db.write();
        db.execute(
            r#"
            INSERT INTO audit_log (
                timestamp, session_id, action, origin, target, arguments,
                risk_class, outcome, action_hash, page_revision, user_confirmed, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                entry.timestamp.to_rfc3339(),
                entry.session_id,
                entry.action,
                entry.origin,
                entry.target,
                serde_json::to_string(&entry.arguments)?,
                serde_json::to_string(&entry.risk_class)?,
                serde_json::to_string(&entry.outcome)?,
                entry.action_hash,
                entry.page_revision as i64,
                entry.user_confirmed as i64,
                entry.error,
            ],
        )?;
        Ok(())
    }

    pub fn get_audit_log(&self, session_id: Option<&str>, limit: usize) -> Result<Vec<AuditEntry>> {
        let db = self.db.read();
        let mut query = String::from("SELECT id, timestamp, session_id, action, origin, target, arguments, risk_class, outcome, action_hash, page_revision, user_confirmed, error FROM audit_log");
        let mut params_vec = vec![];

        if let Some(sid) = session_id {
            query.push_str(" WHERE session_id = ?");
            params_vec.push(sid.to_string());
        }

        query.push_str(" ORDER BY timestamp DESC LIMIT ?");
        params_vec.push(limit.to_string());

        let mut stmt = db.prepare(&query)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

        let entries = stmt.query_map(&*param_refs, |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                timestamp: DateTime::parse_from_rfc3339(&row.get::<_, String>(1)?).unwrap().with_timezone(&Utc),
                session_id: row.get(2)?,
                action: row.get(3)?,
                origin: row.get(4)?,
                target: row.get(5)?,
                arguments: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                risk_class: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(RiskClass::Write),
                outcome: serde_json::from_str(&row.get::<_, String>(8)?).unwrap_or(AuditOutcome::Failed),
                action_hash: row.get(9)?,
                page_revision: row.get(10)?,
                user_confirmed: row.get(11)?,
                error: row.get(12)?,
            })
        })?.collect::<Result<Vec<_>, _>>()?;

        Ok(entries)
    }

    pub fn get_token_usage(&self) -> u64 {
        *self.token_usage.read()
    }

    pub fn reset_token_budget(&self) {
        *self.token_usage.write() = 0;
        *self.last_reset.write() = Utc::now();
    }

    pub fn get_config(&self) -> PolicyConfig {
        self.config.read().clone()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRequest {
    pub session_id: String,
    pub action: String,
    pub origin: String,
    pub target: String,
    pub arguments: Value,
}