// Input Executor — Transparent CDP Input API Execution
// Per Architecture Blueprint Section 7: transparent input execution, no deception
// "Human-like timing may be used only for usability—such as waiting for rendering or avoiding accidental double submission—not to deceive a destination site."

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tracing::{debug, info};

use crate::cdp::CdpManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationProfile {
    pub speed: f64,
    pub jitter: f64,
    pub error_rate: f64,
}

impl Default for SimulationProfile {
    fn default() -> Self {
        Self { speed: 1.0, jitter: 0.0, error_rate: 0.0 }
    }
}

pub struct InputExecutor {
    cdp_manager: Arc<CdpManager>,
}

impl InputExecutor {
    pub fn new() -> Result<Self> {
        Ok(Self {
            cdp_manager: Arc::new(CdpManager::new()?),
        })
    }

    /// Click at exact coordinates via CDP Input.dispatchMouseEvent
    /// Produces trusted events entering Chrome's native input pipeline
    pub async fn click(&self, x: f64, y: f64, _profile: SimulationProfile) -> Result<()> {
        // Mouse down
        self.send_mouse_event("mousePressed", x, y, "left", 1).await?;
        // Small delay for usability (not deception) - avoids accidental double-submit
        sleep(Duration::from_millis(20)).await;
        // Mouse up
        self.send_mouse_event("mouseReleased", x, y, "left", 1).await?;
        // Click event
        self.send_mouse_event("click", x, y, "left", 1).await?;

        Ok(())
    }

    /// Type text via CDP Input.dispatchKeyEvent
    /// Produces trusted events for each character
    pub async fn type_text(&self, text: String, _profile: SimulationProfile) -> Result<()> {
        for ch in text.chars() {
            // Key down
            self.send_key_event("keyDown", ch).await?;
            // Small delay for usability
            sleep(Duration::from_millis(10)).await;
            // Key up
            self.send_key_event("keyUp", ch).await?;
        }
        Ok(())
    }

    /// Scroll via CDP Input.synthesizeScrollGesture
    /// Uses native scroll gesture with momentum
    pub async fn scroll(&self, x: f64, y: f64, delta_x: f64, delta_y: f64, profile: SimulationProfile) -> Result<()> {
        self.send_scroll_gesture(x, y, delta_x, delta_y, profile.speed).await?;
        Ok(())
    }

    /// Move mouse via CDP Input.dispatchMouseEvent
    /// Simple linear movement - no physics simulation for deception
    pub async fn mouse_move(&self, from_x: f64, from_y: f64, to_x: f64, to_y: f64, profile: SimulationProfile) -> Result<()> {
        let distance = ((to_x - from_x).powi(2) + (to_y - from_y).powi(2)).sqrt();
        if distance < 1.0 { return Ok(()); }

        // Simple linear interpolation over ~10 steps for usability
        let steps = (distance / 10.0).ceil() as usize;
        let steps = steps.max(5).min(20);

        for i in 1..=steps {
            let progress = i as f64 / steps as f64;
            let x = from_x + (to_x - from_x) * progress;
            let y = from_y + (to_y - from_y) * progress;
            self.send_mouse_event("mouseMoved", x, y, "none", 0).await?;
            sleep(Duration::from_millis(16)).await; // ~60fps
        }

        // Final precise position
        self.send_mouse_event("mouseMoved", to_x, to_y, "none", 0).await?;
        Ok(())
    }

    async fn send_mouse_event(&self, event_type: &str, x: f64, y: f64, button: &str, click_count: i32) -> Result<()> {
        let params = serde_json::json!({
            "type": event_type,
            "x": x,
            "y": y,
            "button": button,
            "clickCount": click_count,
            "modifiers": 0
        });

        for session_id in self.cdp_manager.active_sessions() {
            let _ = self.cdp_manager.send_command(&session_id, "Input", "dispatchMouseEvent", params.clone()).await;
        }
        Ok(())
    }

    async fn send_key_event(&self, event_type: &str, key: char) -> Result<()> {
        let (key_str, code, text) = match key {
            '\u{8}' => ("Backspace", "Backspace", ""),
            '\n' => ("Enter", "Enter", "\n"),
            '\t' => ("Tab", "Tab", "\t"),
            ' ' => ("Space", "Space", " "),
            c if c.is_ascii() => {
                let upper = c.to_uppercase().to_string();
                (upper.as_str(), &format!("Key{}", upper), c.to_string().as_str())
            }
            _ => ("Unidentified", "Unidentified", ""),
        };

        let params = serde_json::json!({
            "type": event_type,
            "key": key_str,
            "code": code,
            "text": text,
            "modifiers": 0
        });

        for session_id in self.cdp_manager.active_sessions() {
            let _ = self.cdp_manager.send_command(&session_id, "Input", "dispatchKeyEvent", params.clone()).await;
        }
        Ok(())
    }

    async fn send_scroll_gesture(&self, x: f64, y: f64, delta_x: f64, delta_y: f64, speed: f64) -> Result<()> {
        let params = serde_json::json!({
            "x": x,
            "y": y,
            "xDistance": delta_x,
            "yDistance": delta_y,
            "speed": speed * 100.0,
            "preventFling": false
        });

        for session_id in self.cdp_manager.active_sessions() {
            let _ = self.cdp_manager.send_command(&session_id, "Input", "synthesizeScrollGesture", params.clone()).await;
        }
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        !self.cdp_manager.active_sessions().is_empty()
    }
}