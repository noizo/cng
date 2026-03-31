variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Workers AI Read+Edit, Account Analytics Read, optionally Workers KV Storage Edit)"
  type        = string
  sensitive   = true
}

variable "api_key" {
  description = "Admin gateway key (generate: openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  type        = string
  sensitive   = true
}

variable "worker_name" {
  description = "Worker script name"
  type        = string
  default     = "cng"
}

variable "enable_kv" {
  description = "Create a KV namespace for persistent config and dynamic users (requires paid plan)"
  type        = bool
  default     = false
}

variable "custom_domain" {
  description = "Custom domain hostname (e.g. llm.example.com). Leave empty to use workers.dev only"
  type        = string
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID (required only when custom_domain is set)"
  type        = string
  default     = ""
}
