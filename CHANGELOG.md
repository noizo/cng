# Changelog

## Unreleased

### Added
- Centralized AI abstraction layer (`src/ai.js`) — `env.AI` binding with REST fallback
- Starter model catalog prompt in setup script
- `STARTER_CONFIG` export for opt-in default models
- Terraform examples (`examples/terraform/`) with worker, KV, custom domain, and SSO
- User seeding documentation for non-KV deployments
- `reasoning_content` relay for streaming and non-streaming chat
- Minimum `max_tokens` floor of 256 for reasoning models
- Workers AI binding (`[ai]`) in `wrangler.toml`
- `.dev.vars.example` for local development
- Node.js prerequisite check in setup script

### Changed
- `DEFAULT_CONFIG` is now empty — no hardcoded models or aliases
- SSO documentation: manual dashboard setup is primary, Terraform is secondary
- Merged `install.sh` and `setup.sh` into a single script (auto-detects clone vs curl)
- All handlers import from `src/ai.js` instead of duplicating REST fetch logic
- `extractB64` returns error details on all failure paths
- Streaming error events include original error message

### Fixed
- Auth: users in `GATEWAY_CONFIG` now authenticate without KV (`env.CONFIG` gate removed)
- Image generation: spoofed model name returned in response when spoof mode is on
- Terraform: custom domain no longer re-provisions SSL on every deploy

## 1.0.0

Initial release.
