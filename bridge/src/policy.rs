// Policy Engine + Audit Log
// Per Architecture Blueprint Sections 5 & 7: JSON Schema validation, audit log, confirmation gates

use anyhow::Result;
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
    /// Authorized but not yet executed; the extension reports the real
    /// `Success`/`Failed` via an ACTION_RESULT follow-up (MOMO-056).
    Pending,
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
    db: Arc<Mutex<Connection>>,
    token_usage: RwLock<u64>,
    last_reset: RwLock<DateTime<Utc>>,
    mcp_mode: RwLock<bool>,
}

impl PolicyEngine {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let db = Connection::open(&db_path)?;
        Self::init_schema(&db)?;

        Ok(Self {
            config: RwLock::new(PolicyConfig::default()),
            db: Arc::new(Mutex::new(db)),
            token_usage: RwLock::new(0),
            last_reset: RwLock::new(Utc::now()),
            mcp_mode: RwLock::new(false),
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
        let db = self.db.lock().unwrap();
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
        let mut db = self.db.lock().unwrap();
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

    /// Whether a URL or bare origin is allowed by the domain allowlist.
    ///
    /// Fails closed: an empty allowlist denies everything (the agent must be
    /// explicitly configured with at least one trusted domain). Wildcard
    /// entries (`*.example.com`) match the domain and its subdomains only —
    /// never look-alike domains such as `evil-example.com`.
    pub fn check_origin(&self, url: &str) -> bool {
        let config = self.config.read();
        if config.allowlist.is_empty() {
            return false;
        }
        let host = Self::normalize_host(url);
        if host.is_empty() {
            return false;
        }
        config.allowlist.iter().any(|allowed| {
            let wildcard = allowed.trim().starts_with("*.");
            let domain = Self::normalize_host(allowed);
            if domain.is_empty() {
                return false;
            }
            if wildcard {
                host == domain || host.ends_with(&format!(".{}", domain))
            } else {
                host == domain
            }
        })
    }

    fn normalize_host(input: &str) -> String {
        let trimmed = input.trim();
        let stripped = trimmed.strip_prefix("*.").unwrap_or(trimmed);
        if let Ok(u) = Url::parse(stripped) {
            if let Some(host) = u.host_str() {
                return host.to_lowercase();
            }
        }
        stripped
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split(['/', ':', '?', '#'])
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase()
    }

    pub fn check_action_permitted(&self, action: &str) -> bool {
        let config = self.config.read();
        if config.permitted_actions.is_empty() {
            return !*self.mcp_mode.read();
        }
        config.permitted_actions.contains(&action.to_string())
    }

    pub fn set_mcp_mode(&self, enabled: bool) {
        *self.mcp_mode.write() = enabled;
    }

    pub fn evaluate(&self, request: &PolicyRequest) -> Result<PolicyDecision> {
        let config = self.config.read();

        // Enforce the domain allowlist. Navigation is gated on the destination
        // URL; every other action is gated on the current page origin. An empty
        // allowlist denies everything (fail closed).
        if request.action == "navigate" {
            let url = request.arguments.get("url").and_then(|v| v.as_str());
            match url {
                None => return Ok(PolicyDecision {
                    allowed: false,
                    requires_confirmation: false,
                    reason: Some("navigate requires a string 'url' argument".to_string()),
                    risk_class: RiskClass::Navigation,
                    confirmation_data: None,
                }),
                Some(u) if !self.check_origin(u) => return Ok(PolicyDecision {
                    allowed: false,
                    requires_confirmation: false,
                    reason: Some(format!("Origin not on allowlist: {}", u)),
                    risk_class: RiskClass::Navigation,
                    confirmation_data: None,
                }),
                Some(_) => {}
            }
        } else if !self.check_origin(&request.origin) {
            return Ok(PolicyDecision {
                allowed: false,
                requires_confirmation: false,
                reason: Some(format!("Origin not on allowlist: {}", request.origin)),
                risk_class: self.classify_risk(&request.action),
                confirmation_data: None,
            });
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

        // Check token budget (H55): reset window, check, and deduct inside a
        // single critical section so concurrent evaluations cannot race the
        // check against the write.
        let tokens_needed = self.estimate_tokens(&request.action);
        {
            let mut usage = self.token_usage.write();
            let mut last_reset = self.last_reset.write();
            if Utc::now().signed_duration_since(*last_reset)
                >= chrono::Duration::hours(config.token_budget.reset_interval_hours as i64)
            {
                *usage = 0;
                *last_reset = Utc::now();
            }
            if *usage + tokens_needed > config.token_budget.max_tokens {
                return Ok(PolicyDecision {
                    allowed: false,
                    requires_confirmation: false,
                    reason: Some("Token budget exceeded".to_string()),
                    risk_class: risk_class.clone(),
                    confirmation_data: None,
                });
            }
            *usage += tokens_needed;
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

        Ok(decision)
    }

    fn classify_risk(&self, action: &str) -> RiskClass {
        let action = action.to_lowercase();
        if action.contains("navigate") {
            RiskClass::Navigation
        } else if ["pay", "purchase", "checkout", "transfer"]
            .iter()
            .any(|kw| action.contains(kw))
        {
            RiskClass::Payment
        } else if ["auth", "login", "logout", "password"]
            .iter()
            .any(|kw| action.contains(kw))
        {
            RiskClass::Auth
        } else if action.contains("dangerous") {
            RiskClass::Dangerous
        } else if ["observe", "read", "extract", "status"]
            .iter()
            .any(|kw| action.contains(kw))
        {
            RiskClass::Read
        } else {
            RiskClass::Write
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
            "mouse_move" => 1,
            "human_click" => 10,
            "human_type" => 5,
            _ => 10,
        }
    }

    fn requires_confirmation(&self, config: &PolicyConfig, risk_class: &RiskClass, request: &PolicyRequest) -> bool {
        match config.confirmation_policy {
            ConfirmationPolicy::Always => true,
            ConfirmationPolicy::Never => false,
            ConfirmationPolicy::Sensitive => {
                matches!(risk_class, RiskClass::Payment | RiskClass::Auth | RiskClass::Dangerous)
                    || (matches!(request.action.as_str(), "type" | "human_type") && self.is_sensitive_field(request))
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
            // Focused-element typing (no selector): the extension resolves the
            // active element and reports its sensitivity. Fail closed when the
            // flag is absent so an unqualified type is treated as sensitive.
            request.arguments
                .get("field_is_sensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
        }
    }

    fn is_reversible(&self, action: &str) -> bool {
        matches!(action, "navigate" | "scroll" | "wait" | "observe" | "extract" | "mouse_move")
    }

    pub fn log_audit(&self, entry: &AuditEntry) -> Result<()> {
        let db = self.db.lock().unwrap();
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

    /// Update the outcome of a previously written audit entry once the extension
    /// reports the real execution result. Correlated by `action_hash` (the content
    /// hash of the original `PolicyRequest`) scoped to the session, so an
    /// authorize-time `Pending`/`Escalated` can be corrected to `Success`/`Failed`
    /// after the action actually runs (MOMO-056).
    pub fn update_audit_outcome(
        &self,
        session_id: &str,
        action_hash: &str,
        outcome: AuditOutcome,
        error: Option<String>,
    ) -> Result<usize> {
        let db = self.db.lock().unwrap();
        let pending = serde_json::to_string(&AuditOutcome::Pending)?;
        let escalated = serde_json::to_string(&AuditOutcome::Escalated)?;
        let changed = db.execute(
            "UPDATE audit_log SET outcome = ?, error = ? WHERE id = (SELECT id FROM audit_log WHERE action_hash = ? AND session_id = ? AND outcome IN (?, ?) ORDER BY id DESC LIMIT 1)",
            params![
                serde_json::to_string(&outcome)?,
                error,
                action_hash,
                session_id,
                pending,
                escalated,
            ],
        )?;
        Ok(changed)
    }

    pub fn get_audit_log(&self, session_id: Option<&str>, limit: usize) -> Result<Vec<AuditEntry>> {
        let limit = limit.min(1000);
        let db = self.db.lock().unwrap();
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

        let entries = stmt
            .query_map(&*param_refs, |row| {
                let timestamp = match DateTime::parse_from_rfc3339(&row.get::<_, String>(1)?) {
                    Ok(ts) => ts.with_timezone(&Utc),
                    Err(_) => return Ok(None),
                };
                Ok(Some(AuditEntry {
                    id: row.get(0)?,
                    timestamp,
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
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();

        Ok(entries)
    }

    pub fn get_token_usage(&self) -> u64 {
        *self.token_usage.read()
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
    pub page_revision: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn engine_with_allowlist(allowlist: Vec<String>) -> PolicyEngine {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "momo-policy-test-{}-{}.db",
            std::process::id(),
            n
        ));
        let engine = PolicyEngine::new(path.clone()).expect("open test db");
        let mut config = PolicyConfig::default();
        config.allowlist = allowlist;
        engine.save_config(&config).expect("save config");
        let _ = std::fs::remove_file(path);
        engine
    }

    #[test]
    fn empty_allowlist_fails_closed() {
        let engine = engine_with_allowlist(vec![]);
        assert!(!engine.check_origin("https://example.com"));
        assert!(!engine.check_origin("https://example.com/path"));
    }

    #[test]
    fn exact_domain_matches_only_that_domain() {
        let engine = engine_with_allowlist(vec!["example.com".to_string()]);
        assert!(engine.check_origin("https://example.com"));
        assert!(engine.check_origin("https://example.com/path?q=1"));
        assert!(!engine.check_origin("https://sub.example.com"));
        assert!(!engine.check_origin("https://evil-example.com"));
    }

    #[test]
    fn wildcard_matches_domain_and_subdomains_only() {
        let engine = engine_with_allowlist(vec!["*.example.com".to_string()]);
        assert!(engine.check_origin("https://example.com"));
        assert!(engine.check_origin("https://sub.example.com"));
        assert!(engine.check_origin("https://a.b.example.com"));
        // Look-alike / suffix-attack domains must be denied.
        assert!(!engine.check_origin("https://evil-example.com"));
        assert!(!engine.check_origin("https://example.com.evil.com"));
        assert!(!engine.check_origin("https://notexample.com"));
    }

    #[test]
    fn host_normalization_handles_case_ports_and_scheme() {
        let engine = engine_with_allowlist(vec!["*.example.com".to_string()]);
        assert!(engine.check_origin("https://Example.COM:8443/path?q=1#frag"));
        assert!(engine.check_origin("http://sub.example.com"));
        // Malformed / bare junk hosts are never allowed.
        assert!(!engine.check_origin("not-a-url"));
        assert!(!engine.check_origin(""));
    }

    #[test]
    fn evaluate_denies_non_allowlisted_origin() {
        let engine = engine_with_allowlist(vec!["example.com".to_string()]);
        let request = PolicyRequest {
            session_id: "s1".into(),
            action: "human_type".into(),
            origin: "https://evil.com".into(),
            target: "#password".into(),
            arguments: Value::Null,
            page_revision: 0,
        };
        let decision = engine.evaluate(&request).expect("evaluate");
        assert!(!decision.allowed);
    }

    #[test]
    fn evaluate_denies_when_allowlist_empty() {
        let engine = engine_with_allowlist(vec![]);
        let request = PolicyRequest {
            session_id: "s1".into(),
            action: "human_click".into(),
            origin: "https://example.com".into(),
            target: "#submit".into(),
            arguments: Value::Null,
            page_revision: 0,
        };
        let decision = engine.evaluate(&request).expect("evaluate");
        assert!(!decision.allowed);
    }

    #[test]
    fn focused_human_type_uses_field_sensitivity_flag() {
        let engine = engine_with_allowlist(vec!["example.com".to_string()]);
        let sensitive = PolicyRequest {
            session_id: "s1".into(),
            action: "human_type".into(),
            origin: "https://example.com".into(),
            target: "focused-element".into(),
            arguments: serde_json::json!({ "selector": null, "text_length": 8, "field_is_sensitive": true }),
            page_revision: 0,
        };
        let insensitive = PolicyRequest {
            session_id: "s1".into(),
            action: "human_type".into(),
            origin: "https://example.com".into(),
            target: "focused-element".into(),
            arguments: serde_json::json!({ "selector": null, "text_length": 8, "field_is_sensitive": false }),
            page_revision: 0,
        };
        assert!(engine.evaluate(&sensitive).unwrap().requires_confirmation);
        assert!(!engine.evaluate(&insensitive).unwrap().requires_confirmation);
    }

    #[test]
    fn focused_human_type_without_flag_fails_closed() {
        let engine = engine_with_allowlist(vec!["example.com".to_string()]);
        let request = PolicyRequest {
            session_id: "s1".into(),
            action: "human_type".into(),
            origin: "https://example.com".into(),
            target: "focused-element".into(),
            arguments: serde_json::json!({ "selector": null, "text_length": 8 }),
            page_revision: 0,
        };
        assert!(engine.evaluate(&request).unwrap().requires_confirmation);
    }

    #[test]
    fn update_audit_outcome_overwrites_decision_outcome() {
        // Unlike engine_with_allowlist (which unlinks the DB file immediately
        // after save_config), this test must keep the file present so the SQLite
        // connection remains writable for log_audit / update_audit_outcome.
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "momo-policy-update-test-{}-{}.db",
            std::process::id(),
            n
        ));
        let engine = PolicyEngine::new(path.clone()).expect("open test db");

        let entry = AuditEntry {
            id: 0,
            timestamp: Utc::now(),
            session_id: "s1".into(),
            action: "navigate".into(),
            origin: "https://example.com".into(),
            target: "https://example.com".into(),
            arguments: Value::Null,
            risk_class: RiskClass::Navigation,
            outcome: AuditOutcome::Pending,
            action_hash: "h1".into(),
            page_revision: 7,
            user_confirmed: false,
            error: None,
        };
        engine.log_audit(&entry).expect("log audit");

        let changed = engine
            .update_audit_outcome("s1", "h1", AuditOutcome::Failed, Some("boom".into()))
            .expect("update");
        assert_eq!(changed, 1);

        let log = engine.get_audit_log(Some("s1"), 10).expect("read");
        assert_eq!(log.len(), 1);
        assert!(matches!(&log[0].outcome, AuditOutcome::Failed));
        assert_eq!(log[0].error.as_deref(), Some("boom"));

        let _ = std::fs::remove_file(path);
    }
}