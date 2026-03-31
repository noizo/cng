# Optional: protect /config with GitHub SSO via Cloudflare Access.
#
# Prerequisites:
#   1. Create a GitHub OAuth App at https://github.com/settings/developers
#      - Homepage URL:               https://your-worker-domain/config
#      - Authorization callback URL: https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
#   2. Set the client_id and client_secret variables below
#
# The manual dashboard equivalent is documented in the main README.

variable "enable_sso" {
  description = "Enable GitHub SSO for the config panel via Cloudflare Access"
  type        = bool
  default     = false
}

variable "github_oauth_client_id" {
  description = "GitHub OAuth App client ID"
  type        = string
  default     = ""
}

variable "github_oauth_client_secret" {
  description = "GitHub OAuth App client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sso_allowed_emails" {
  description = "Email addresses allowed through SSO (your GitHub email)"
  type        = list(string)
  default     = []
}

variable "sso_session_duration" {
  description = "SSO session duration"
  type        = string
  default     = "24h"
}

# ── Identity provider ─────────────────────────────────────────

resource "cloudflare_zero_trust_access_identity_provider" "github" {
  count = var.enable_sso ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "GitHub (CNG)"
  type       = "github"

  config = {
    client_id     = var.github_oauth_client_id
    client_secret = var.github_oauth_client_secret
  }
}

# ── Access application ────────────────────────────────────────

resource "cloudflare_zero_trust_access_application" "config_panel" {
  count = var.enable_sso ? 1 : 0

  account_id                = var.cloudflare_account_id
  name                      = "CNG Config Panel"
  domain                    = var.custom_domain != "" ? "${var.custom_domain}/config" : "${var.worker_name}.workers.dev/config"
  type                      = "self_hosted"
  session_duration          = var.sso_session_duration
  auto_redirect_to_identity = true
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.github[0].id]

  policies = [{
    name       = "Allow admin"
    precedence = 1
    decision   = "allow"
    include = [for email in var.sso_allowed_emails : {
      email = { email = email }
    }]
  }]
}
