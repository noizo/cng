terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ── KV namespace (optional) ───────────────────────────────────

resource "cloudflare_workers_kv_namespace" "cng" {
  count = var.enable_kv ? 1 : 0

  account_id = var.cloudflare_account_id
  title      = "${var.worker_name}-config"
}

# ── Worker script ──────────────────────────────────────────────

locals {
  base_bindings = [
    { name = "AI", type = "ai" },
    { name = "CF_ACCOUNT_ID", text = var.cloudflare_account_id, type = "plain_text" },
    { name = "CF_API_TOKEN", text = var.cloudflare_api_token, type = "secret_text" },
    { name = "API_KEY", text = var.api_key, type = "secret_text" },
  ]

  kv_bindings = var.enable_kv ? [
    { name = "CONFIG", namespace_id = cloudflare_workers_kv_namespace.cng[0].id, type = "kv_namespace" },
  ] : []
}

resource "cloudflare_workers_script" "cng" {
  account_id         = var.cloudflare_account_id
  script_name        = var.worker_name
  content            = file("${path.module}/../../dist/cng.js")
  main_module        = "cng.js"
  compatibility_date = "2025-01-01"

  bindings = concat(local.base_bindings, local.kv_bindings)
}

# ── Optional: custom domain ───────────────────────────────────

resource "cloudflare_workers_custom_domain" "cng" {
  count = var.custom_domain != "" ? 1 : 0

  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = var.custom_domain
  service    = var.worker_name

  lifecycle {
    create_before_destroy = true
  }
}

# ── Enable workers.dev subdomain ──────────────────────────────

resource "terraform_data" "workers_dev" {
  triggers_replace = [var.worker_name]

  provisioner "local-exec" {
    command = <<-EOT
      curl -sf -X POST \
        -H "Authorization: Bearer ${var.cloudflare_api_token}" \
        -H "Content-Type: application/json" \
        -d '{"enabled": true}' \
        "https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/workers/scripts/${var.worker_name}/subdomain"
    EOT
  }
}
