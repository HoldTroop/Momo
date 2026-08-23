# Risk Threshold Enforcement (disc-4)

## What it needs to do
Implement numeric threshold-based risk classification instead of pure keyword matching. Track action frequency per user/session and compare against configured thresholds (read, write, navigation, payment, auth, dangerous) to determine risk level.

## Files/modules it would touch
- `bridge/src/policy.rs`: Refactor `classify_risk()` to use threshold values
- New module for action frequency tracking (likely `bridge/src/tracking.rs`)
- Database schema for action counters/history
- Integration with existing policy evaluation flow in orchestrator

## Biggest open design question
What do threshold values represent? Action count per time window? Weighted severity score? How is the frequency window defined (per session, sliding time window, daily reset)? Should thresholds be cumulative or per-action-type?

## Rough size estimate
Medium (2-3 days): requires database schema changes, new tracking infrastructure, refactoring classify_risk logic, and integration testing with policy enforcement flow.
