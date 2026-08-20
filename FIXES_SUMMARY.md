# Momo Security Fixes - Summary

**Date:** 2026-08-19
**Status:** ✅ All fixes applied and verified

---

## Issue #1: IMMEDIATE - human_type variable shadowing

### Problem
The `fieldIsSensitive` variable was shadowed inside the `if (refId)` block, causing the authorization check to use the wrong sensitivity value when `ref_id` was provided. If a `ref_id` targeted a password field but `document.activeElement` pointed to a plain text field, the bridge would incorrectly receive `sensitive=false`.

### Fix Location
`src/lib/tool-registry.ts` lines 1155-1211

### Before/After Diff
```diff
@@ -1152,6 +1152,7 @@
         const refId = args.ref_id as string | undefined;
         const origin = originOf(context.dom.url);
         let target = 'focused-element';
+        let fieldIsSensitive: boolean;
 
         // If ref_id provided, focus that element first
         if (refId) {
@@ -1182,34 +1183,34 @@
             return { success: false, error: res?.error || 'Failed to resolve ref_id', summary: `Human type failed: ${res?.error}`, navigationOccurred: false };
           }
           target = `ref_id(${refId})`;
-          const fieldIsSensitive = isSensitiveInput(res);  // ❌ SHADOWING
-        }
+          fieldIsSensitive = isSensitiveInput(res);        // ✅ ASSIGNMENT
+        } else {
+          // Resolve the currently-focused element...
+          let focusedCheck;
+          try {
+            focusedCheck = await chrome.scripting.executeScript({...});
+          } catch (e) {
+            return { success: false, error: String(e), summary: 'Human type failed', navigationOccurred: false };
+          }
 
-        const focusedField = focusedCheck[0]?.result;
-        const fieldIsSensitive = focusedField ? isSensitiveInput(focusedField) : true;  // ❌ OUTER SCOPE
+          const focusedField = focusedCheck[0]?.result;
+          fieldIsSensitive = focusedField ? isSensitiveInput(focusedField) : true;  // ✅ ASSIGNMENT
+        }
```

### Verification
- **Unit test:** `src/lib/__tests__/tool-registry-shadowing.test.ts`
- **Test result:** ✅ 3/3 tests passing
- **Key assertion:** Verifies `fieldIsSensitive` is declared once in outer scope and assigned (not re-declared) in both branches

---

## Issue #2: HIGH - MD5 → SHA-256 in action_hash

### Problem
The `action_hash` used MD5, which is cryptographically broken and unsuitable for audit integrity verification.

### Fix Location
`bridge/src/main.rs` lines 7, 132

### Before/After Diff
```diff
@@ -5,7 +5,7 @@
 use anyhow::Result;
 use axum::{routing::get, Router};
 use dirs;
-use md5::{Digest, Md5};
+use sha2::{Digest, Sha256};
 use serde::{Deserialize, Serialize};

@@ -129,7 +129,7 @@
     pub(crate) async fn authorize(&self, request: PolicyRequest) -> Result<serde_json::Value> {
         // Hash and audit-entry shaping are CPU-only and stay async-side;
         // DB-touching evaluate/log_audit pair runs inside spawn_blocking.
-        let action_hash = format!("{:x}", Md5::digest(serde_json::to_string(&request)?.as_bytes()));
+        let action_hash = format!("{:x}", Sha256::digest(serde_json::to_string(&request)?.as_bytes()));
         let entry_hash = action_hash.clone();
```

### Verification
- **Cargo.toml:** Updated `sha2` dependency (already present)
- **Cargo test:** ✅ 36/36 tests passing
- **Hash output:** SHA-256 produces 64-character hex string (vs MD5's 32)

---

## Issue #3: MEDIUM - WebSocket origin hardening

### Problem
The WebSocket origin validation accepted any `chrome-extension://` origin without verifying the exact extension ID, allowing a malicious extension to connect if it knew the bearer token.

### Fix Location
`bridge/src/ws_server.rs` lines 536-556

### Before/After Diff
```diff
@@ -532,11 +532,27 @@
 
 /// C6: only `chrome-extension://` origins may open the WebSocket. `None`
-/// (non-browser clients) is allowed.
+/// (non-browser clients) is allowed for MCP mode.
+/// When MOMO_EXTENSION_ID env var is set, validates exact extension ID.
 fn origin_allowed(origin: Option<&str>) -> bool {
     match origin {
-        None => true,
-        Some(o) => o.to_ascii_lowercase().starts_with("chrome-extension://"),
+        None => true,  // Non-browser clients (MCP mode)
+        Some(o) => {
+            let lower = o.to_ascii_lowercase();
+            if !lower.starts_with("chrome-extension://") {
+                return false;
+            }
+            
+            // If MOMO_EXTENSION_ID is set, validate exact ID
+            if let Ok(expected_id) = std::env::var("MOMO_EXTENSION_ID") {
+                let expected = format!("chrome-extension://{}", expected_id.to_lowercase());
+                return lower == expected;
+            }
+            
+            // Development mode: accept any chrome-extension:// origin
+            // Production deployments MUST set MOMO_EXTENSION_ID
+            true
+        }
     }
 }
```

### Verification
- **Unit test:** `bridge/src/ws_server.rs::tests::origin_allowed_unit`
- **Test result:** ✅ Verifies exact ID matching and http rejection
- **Production deployment:** Set `MOMO_EXTENSION_ID` environment variable to enforce exact extension ID

---

## Final Verification

### TypeScript Compilation
```bash
npx tsc --noEmit
```
✅ No errors

### Rust Tests
```bash
cd bridge && cargo test
```
✅ 36 passed, 0 failed, 1 ignored

### Vitest Tests
```bash
npx vitest run
```
✅ 53 tests passed (5 test files)
- `tool-registry-shadowing.test.ts`: 3 passed
- `tool-registry-security.test.ts`: 7 passed
- `redaction.test.ts`: 29 passed
- `perception.test.ts`: 8 passed
- `dom-compressor.test.ts`: 6 passed

### Changed Files
```
bridge/Cargo.lock        | 23 lines
bridge/Cargo.toml        |  2 lines
bridge/src/main.rs       |  4 lines
bridge/src/ws_server.rs  | 22 lines
src/lib/tool-registry.ts | 51 lines
```

---

## Deployment Checklist

- [x] All fixes applied
- [x] Unit tests written and passing
- [x] TypeScript compilation clean
- [x] Cargo tests passing
- [ ] Set `MOMO_EXTENSION_ID` in production environment
- [ ] Rebuild extension: `npm run build`
- [ ] Rebuild bridge: `cd bridge && cargo build --release`
- [ ] Verify action_hash in audit log uses SHA-256 (64 chars)

---

## Notes

All three issues were already fixed in uncommitted changes. This document verifies the fixes and adds regression tests for issue #1.
