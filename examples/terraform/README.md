# CNG — Terraform deployment

Deploy CNG to Cloudflare Workers using Terraform for reproducible, version-controlled infrastructure.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
- A [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the required scopes (see main README)
- The CNG bundle built at `dist/cng.js` — run `npm run bundle` from the repo root

## Quick start

```bash
cd examples/terraform

# 1. Create your tfvars
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 2. Init and apply
terraform init
terraform plan
terraform apply
```

## What gets created

| Resource | Description |
|----------|-------------|
| `cloudflare_workers_script.cng` | The worker script with AI, secrets, and optional KV bindings |
| `cloudflare_workers_kv_namespace.cng` | KV namespace for persistent config *(only if `enable_kv = true`)* |
| `cloudflare_workers_custom_domain.cng` | Custom domain mapping *(only if `custom_domain` is set)* |
| `terraform_data.workers_dev` | Enables the `*.workers.dev` subdomain |

## Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `cloudflare_account_id` | Yes | — | Cloudflare account ID |
| `cloudflare_api_token` | Yes | — | API token (sensitive) |
| `api_key` | Yes | — | Admin gateway key (sensitive) |
| `worker_name` | No | `cng` | Worker script name |
| `enable_kv` | No | `false` | Create KV namespace (requires paid plan) |
| `custom_domain` | No | `""` | Custom domain hostname |
| `cloudflare_zone_id` | No | `""` | Zone ID (required with custom_domain) |

## SSO (optional)

The `sso.tf` file adds GitHub SSO for the config panel via Cloudflare Zero Trust Access. Enable it by setting these variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `enable_sso` | No | `false` | Enable GitHub SSO |
| `github_oauth_client_id` | When SSO on | `""` | GitHub OAuth App client ID |
| `github_oauth_client_secret` | When SSO on | `""` | GitHub OAuth App client secret (sensitive) |
| `sso_allowed_emails` | When SSO on | `[]` | Email addresses allowed through SSO |
| `sso_session_duration` | No | `24h` | Session cookie lifetime |

### Setting up the GitHub OAuth App

1. Go to [github.com/settings/developers](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name:** CNG Config Panel
   - **Homepage URL:** `https://your-worker-domain/config`
   - **Authorization callback URL:** `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
4. Note the **Client ID** and generate a **Client Secret**

Your team name is the subdomain you chose during Cloudflare Zero Trust onboarding (visible at Zero Trust → Settings → Custom Pages).

### Example tfvars with SSO

```hcl
enable_sso                 = true
github_oauth_client_id     = "Iv1.abc123"
github_oauth_client_secret = "secret123"
sso_allowed_emails         = ["you@example.com", "teammate@example.com"]
```

After `terraform apply`, visiting `/config` redirects to GitHub login. Cloudflare sets a session cookie for the configured duration.

## Resetting the admin key

```bash
# 1. Generate a new key
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# 2. Update terraform.tfvars
#    api_key = "<new-key>"

# 3. Apply
terraform apply
```

Then clear the old key from your browser: `localStorage.removeItem("cng_key")` and enter the new key at `/config`.

## Importing existing resources

If you already deployed CNG via wrangler and want to switch to Terraform:

```bash
terraform import cloudflare_workers_script.cng <account-id>/<worker-name>
```

## File structure

```
examples/terraform/
├── main.tf                    # Worker, KV, custom domain
├── variables.tf               # Input variables
├── sso.tf                     # GitHub SSO (optional, gated by enable_sso)
├── outputs.tf                 # URLs and domain outputs
├── terraform.tfvars.example   # Example variable values
└── README.md                  # This file
```
