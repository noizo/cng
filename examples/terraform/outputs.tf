output "worker_url" {
  description = "Worker URL on workers.dev"
  value       = "https://${var.worker_name}.workers.dev"
}

output "config_panel_url" {
  description = "Config panel URL"
  value       = var.custom_domain != "" ? "https://${var.custom_domain}/config" : "https://${var.worker_name}.workers.dev/config"
}

output "custom_domain" {
  description = "Custom domain (if configured)"
  value       = var.custom_domain != "" ? var.custom_domain : null
}
