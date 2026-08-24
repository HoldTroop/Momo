# Design Stub: actions-1 — File Upload Tool

**Issue**: No file-upload tool (`input[type=file]`)  
**Classification**: code | OPEN

## 1. Files to Modify

- **NEW** `src/lib/tools/upload-file.ts` — Core file-upload logic (locate input, read file, trigger events)
- **MODIFY** `src/lib/tool-registry.ts:L40-50` — Register `upload_file` tool
- **MODIFY** `bridge/src/mcp_tools.rs:L200-250` — Add `upload_file` MCP tool handler
- **MODIFY** `src/sw/message-router.ts:L150-170` — Route `upload_file` action to content script
- **MAYBE** `src/content/perception.ts:L100-120` — Tag file inputs with metadata (accept/multiple)

## 2. MCP Tool Schema

```rust
upload_file {
  selector: string,           // CSS selector or momo_ref for input[type=file]
  file_path: string,          // Absolute path to local file to upload
  mime_type?: string,         // Optional MIME override (default: infer from extension)
  file_name?: string          // Optional filename override (default: basename)
}
```

**Flow**: MCP → Bridge validates path → Extension reads file → Creates File/Blob → Sets `input.files` → Dispatches `change`/`input` events

## 3. Security Implications

- **File system access**: HIGH-RISK — Exposes local files to arbitrary web pages; requires HITL confirmation
- **Path traversal**: Must canonicalize and validate `file_path` is within allowed directories (e.g., `~/Downloads`, user-approved paths)
- **File size limits**: Cap at 100MB to prevent DoS; reject empty files
- **MIME validation**: Verify declared MIME matches file magic bytes to prevent type confusion
- **Privacy leak**: File metadata (path, mtime) must not leak to page; only name/size/type exposed via File API
- **Confirmation policy**: Default `confirmation_policy: "always"` — user must approve each upload with file preview
