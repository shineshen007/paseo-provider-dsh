DeepSeek Harness as a native Paseo provider.

Runs a real DeepSeek Harness (dsh) host and drives it through its own services, so Paseo gets native
plan mode, real model and thinking-effort switching, DeepSeek Harness sandbox and approval presets,
tool approvals, interactive questions, sub-agents as sub-sessions, and resumable sessions that keep
the original harness session id.

Setup: install the DeepSeek Harness CLI, then run `bash scripts/install.sh` from the plugin directory.
That creates a dedicated harness profile and registers this plugin; your existing DeepSeek Harness
profiles are never modified.

Requires Paseo 0.13.x. Supports macOS, Ubuntu and Paseo Remote SSH hosts.
