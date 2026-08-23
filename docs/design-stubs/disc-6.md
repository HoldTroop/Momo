# Data Retention Policy Enforcement (disc-6)

## What it needs to do
Enforce audit log retention based on DataRetentionPolicy (Session vs Persistent). Implement cleanup logic to purge session logs when sessions end and rotate persistent logs based on configurable retention period.

## Files/modules it would touch
- `bridge/src/policy.rs`: Remove `#[allow(dead_code)]` and wire up retention field
- New cleanup module (likely `bridge/src/audit_cleanup.rs`)
- Session lifecycle tracking integration
- Background task scheduler for periodic rotation
- Database queries for log deletion by timestamp/session

## Biggest open design question
When exactly does a "session" end for retention purposes? Browser tab close, user logout, timeout period? Should persistent logs have configurable TTL (30/90/365 days), and where is that configured?

## Rough size estimate
Medium (2-3 days): requires session lifecycle tracking, background cleanup tasks, database deletion logic, configuration schema, and testing retention boundaries.
