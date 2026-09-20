# Vital on AWS — input variables. No real secret values here, ever.
variable "region" {
  description = "AWS region for everything (Vital is single-region by design)"
  type        = string
  default     = "eu-central-1"
}

variable "project" {
  description = "Name prefix for all resources"
  type        = string
  default     = "vital"
}

variable "az_count" {
  description = "AZs to span (2 minimum for ALB + RDS)"
  type        = number
  default     = 2
}
variable "core_image" {
  description = "ECR image URI for vital-core (deploy workflow pushes this), e.g. 123456789012.dkr.ecr.eu-central-1.amazonaws.com/vital-core:sha"
  type        = string
  default     = ""

  validation {
    condition     = length(var.core_image) > 0
    error_message = "core_image must be a real ECR URI — the busybox fallback was removed so a misconfigured apply cannot deploy a dead service. The deploy workflow passes -var core_image explicitly."
  }
}


variable "executor_image" {
  description = "ECR image URI for the Lambda executor container"
  type        = string
  default     = ""

  validation {
    condition     = length(var.executor_image) > 0
    error_message = "executor_image must be a real ECR URI (see core_image)."
  }
}

variable "jcode_image" {
  description = "Container image for the jcode sibling sidecar (Rust harness API over localhost socket)"
  type        = string
  default     = "ghcr.io/1jehuang/jcode:v0.84.0"
}

variable "desired_count" {
  description = "vital-core Fargate tasks behind the ALB (initial count; the target-tracking scaler owns it at runtime within core_min/max_capacity)"
  type        = number
  default     = 2
}

variable "core_min_capacity" {
  description = "Autoscaling floor for vital-core tasks"
  type        = number
  default     = 2
}

variable "core_max_capacity" {
  description = "Autoscaling ceiling for vital-core tasks"
  type        = number
  default     = 6
}

variable "core_requests_per_target" {
  description = "Target ALB requests-per-target for core autoscaling (scale out above it, in below it)"
  type        = number
  default     = 1000
}

variable "jcode_target" {
  description = "STAGED split switch: socket = live sidecar in the core task; tcp = run the standalone jcode service (needs the TCP client step first, see main.tf)"
  type        = string
  default     = "socket"
  validation {
    condition     = contains(["socket", "tcp"], var.jcode_target)
    error_message = "jcode_target must be socket or tcp."
  }
}

variable "jcode_desired_count" {
  description = "Standalone jcode service tasks once jcode_target = tcp (0 until then)"
  type        = number
  default     = 1
}

variable "jcode_cpu" {
  description = "Fargate CPU units for the standalone jcode task"
  type        = string
  default     = "512"
}

variable "jcode_memory" {
  description = "Fargate memory (MB) for the standalone jcode task"
  type        = string
  default     = "1024"
}

variable "nat_per_az" {
  description = "true = one NAT gateway per AZ (pilot+ posture, ~one NAT charge each, no cross-AZ egress dependency); false = single NAT in the first AZ (cheaper, dev default)"
  type        = bool
  default     = false
}

variable "core_cpu" {
  description = "Fargate CPU units for the core task (256|512|1024|2048|4096)"
  type        = string
  default     = "1024"
}

variable "core_memory" {
  description = "Fargate memory (MB) for the core task"
  type        = string
  default     = "2048"
}

variable "db_instance_class" {
  description = "RDS instance class for the Ledger"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  type    = string
  default = "vital"
}

variable "db_username" {
  type    = string
  default = "vital"
}

variable "db_multi_az" {
  description = "Multi-AZ for pilot/prod Ledger (keep true past the first pilot)"
  type        = bool
  default     = true
}

variable "db_max_allocated_storage" {
  description = "RDS storage-autoscaling ceiling in GiB (must exceed the 20 GiB floor; autoscaling grows toward it as free space fills)"
  type        = number
  default     = 100
}

# These six used to default to the literal string "CHANGEME", which meant a
# deploy that forgot a TF_VAR_* shipped a *known* HMAC secret, webhook secret
# and model key — the same failure mode core_image's validation already refuses
# ("a misconfigured apply cannot deploy a dead service"). They now default to
# empty and fail validation, so the apply stops before Secrets Manager, ECS or
# the Lambda ever see a placeholder.

variable "tenant_hmac_secret" {
  description = "TALK HMAC secret (talk surface fallback). Set via TF_VAR_*, never in git."
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = length(var.tenant_hmac_secret) > 0 && var.tenant_hmac_secret != "CHANGEME"
    error_message = "tenant_hmac_secret must be a real secret — it signs the talk surface. Pass it as TF_VAR_tenant_hmac_secret (CI) or tenant_hmac_secret in terraform.tfvars. A placeholder here is a forgeable HMAC on every deployment."
  }
}

variable "vital_core_secret" {
  description = "Core secret minting scope tokens (substrate/identity)"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = length(var.vital_core_secret) > 0 && var.vital_core_secret != "CHANGEME"
    error_message = "vital_core_secret must be a real secret — it mints scope tokens. Pass it as TF_VAR_vital_core_secret (CI) or vital_core_secret in terraform.tfvars."
  }
}

variable "webhook_secret" {
  description = "Shared secret for scheduler webhook intake"
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = length(var.webhook_secret) > 0 && var.webhook_secret != "CHANGEME"
    error_message = "webhook_secret must be a real secret — it authenticates webhook intake. Pass it as TF_VAR_webhook_secret (CI) or webhook_secret in terraform.tfvars. A placeholder here accepts forged webhooks."
  }
}

variable "serper_api_key" {
  description = "Serper (search) API key. Required: the model plane has no keyless mode, so an unrunnable deployment is refused up front."
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = length(var.serper_api_key) > 0 && var.serper_api_key != "CHANGEME"
    error_message = "serper_api_key must be a real key without the placeholder — pass TF_VAR_serper_api_key."
  }
}

variable "bedrock_api_key" {
  description = "Amazon Bedrock API key (Converse HTTP, Bearer auth). Create in Bedrock console → API keys. Must match var.region."
  type        = string
  sensitive   = true
  default     = ""

  validation {
    condition     = length(var.bedrock_api_key) > 0 && var.bedrock_api_key != "CHANGEME"
    error_message = "bedrock_api_key must be a real key — pass TF_VAR_bedrock_api_key."
  }
}

variable "bedrock_prod_model_id" {
  description = "Bedrock foundation model ID for the production lane (Converse API). Default: Z.AI GLM 4.7 Flash (zai.glm-4.7-flash). Enable model access in the account before apply."
  type        = string
  default     = "zai.glm-4.7-flash"
}

variable "bedrock_dev_model_id" {
  description = "Bedrock foundation model ID for the dev lane on AWS."
  type        = string
  default     = "zai.glm-4.7-flash"
}

variable "allowed_egress_hosts" {
  description = "Comma-separated allowlist enforced in code (decideEgress) by core + Lambda executor"
  type        = string
  default     = "api.serper.dev"
}

variable "lambda_memory_mb" {
  description = "Lambda executor memory (CPU scales with it; jcode-class work wants 2048+)"
  type        = number
  default     = 2048
}

variable "lambda_reserved_concurrency" {
  description = "Cap on parallel executor microVMs — the budget-death backstop at the infra layer (0 = unreserved)"
  type        = number
  default     = 20
}

variable "acm_certificate_arn" {
  description = "ACM cert for ALB HTTPS. Empty = HTTP-forward (dev only): approvals travel in plaintext and must never carry production authority. Set for any pilot. Alternative to domain_name (which creates the cert here); an explicit ARN wins if both are set."
  type        = string
  default     = ""
}

variable "domain_name" {
  description = "Public hostname to serve the console on (e.g. console.example.com). Empty = no certificate and no DNS records, port 80 forwards (dev only). Setting it provisions an ACM certificate, validates it by DNS and aliases the name to the ALB — hosted_zone_id must be set too."
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route 53 public hosted zone that owns domain_name. Required when domain_name is set — the zone is looked up, never created, so an apply cannot take over a domain's DNS."
  type        = string
  default     = ""

  validation {
    condition     = var.hosted_zone_id == "" || can(regex("^Z[0-9A-Z]+$", var.hosted_zone_id))
    error_message = "hosted_zone_id must be a Route 53 zone id like Z0123456789ABCDEFGHI, not a domain name. Find it with: aws route53 list-hosted-zones --query 'HostedZones[].{Id:Id,Name:Name}'."
  }
}

variable "subject_alternative_names" {
  description = "Extra hostnames on the same certificate, every one of them inside hosted_zone_id (e.g. [\"www.example.com\"]). A hostname in a different zone will not validate: its DNS validation record would be written to the wrong zone."
  type        = list(string)
  default     = []
}

variable "alb_internal" {
  description = "true = internal ALB in private subnets (no public IP, reachable only via VPN/VPC/peering); false = internet-facing ALB in public subnets (F01: keep deployment private first)"
  type        = bool
  default     = false
}

variable "alb_ingress_cidrs" {
  description = "CIDR blocks permitted to reach the ALB on HTTP(S). Default [\"0.0.0.0/0\"]; restrict to corporate CIDRs or private VPC ranges for private posture."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "operator_secret" {
  description = "Shared secret gating console mutations via x-vital-operator (VITAL_OPERATOR_SECRET). Empty = ungated (loopback dev only). Set for any deployment behind the ALB."
  type        = string
  sensitive   = true
  default     = ""
}

variable "ops_alarm_email" {
  description = "Confirmed-subscription target for ops alarms (RDS free storage, ALB 5xx, executor errors, queue age). Empty = alarms fire but notify nobody — allowed only for throwaway stacks. AWS sends a confirmation mail on apply; the alarms are live only after it is confirmed."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Extra tags merged onto every resource"
  type        = map(string)
  default     = {}
}

variable "enable_buzz" {
  description = "Provision the Buzz relay stack (ECS + RDS + ElastiCache + S3). Replaces the former MinIO/Redis/docker-compose path."
  type        = bool
  default     = true
}

variable "buzz_image" {
  description = "Container image for the Buzz Nostr relay"
  type        = string
  default     = "ghcr.io/block/buzz:main"
}

variable "buzz_desired_count" {
  description = "Buzz relay Fargate tasks behind the ALB + Cloud Map"
  type        = number
  default     = 2
}

variable "buzz_cpu" {
  description = "Fargate CPU units for the Buzz relay task"
  type        = string
  default     = "512"
}

variable "buzz_memory" {
  description = "Fargate memory (MB) for the Buzz relay task"
  type        = string
  default     = "1024"
}

variable "buzz_db_instance_class" {
  description = "RDS instance class for the Buzz Postgres database"
  type        = string
  default     = "db.t4g.micro"
}

variable "buzz_db_name" {
  type    = string
  default = "buzz"
}

variable "buzz_db_username" {
  type    = string
  default = "buzz"
}

variable "buzz_db_multi_az" {
  description = "Multi-AZ for Buzz Postgres (pilot+ posture)"
  type        = bool
  default     = true
}

variable "buzz_db_max_allocated_storage" {
  description = "Buzz RDS storage-autoscaling ceiling in GiB"
  type        = number
  default     = 50
}

variable "buzz_redis_node_type" {
  description = "ElastiCache node type for Buzz Redis"
  type        = string
  default     = "cache.t4g.micro"
}

variable "buzz_relay_private_key" {
  description = "Hex-encoded secp256k1 private key for the Buzz relay identity. Set via TF_VAR_buzz_relay_private_key, never in git."
  type        = string
  sensitive   = true
  default     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

variable "buzz_hostname" {
  description = "Optional host header for public Buzz relay access via the ALB (e.g. buzz.example.com). Empty = internal Cloud Map only. The certificate must cover this name — put it in subject_alternative_names, or supply an acm_certificate_arn that already does."
  type        = string
  default     = ""
}

variable "buzz_agent_master_key" {
  description = "Hex master secret (32+ hex chars) deriving all room agent identities (BUZZ_AGENT_MASTER_KEY). Empty = Buzz publishing fails closed (no identity). Set via TF_VAR_buzz_agent_master_key, never in git."
  type        = string
  sensitive   = true
  default     = ""
}

variable "vital_review_secret" {
  description = "Random 16+ chars signing review-card approve/decline tokens (VITAL_REVIEW_SECRET). Empty = review tokens cannot verify (webhook approve path dead). Set via TF_VAR_vital_review_secret, never in git."
  type        = string
  sensitive   = true
  default     = ""
}

variable "bootstrap_email" {
  description = "Day-0 owner email for first-run claiming (VITAL_BOOTSTRAP_EMAIL). Empty = no bootstrap owner; web signup on a public bind stays gated. Rotate (change password + unset + re-apply) after claiming."
  type        = string
  default     = ""
}

variable "bootstrap_password" {
  description = "Day-0 owner password, forced to change at first login (VITAL_BOOTSTRAP_PASSWORD). Empty = no bootstrap owner. Set via TF_VAR_bootstrap_password, never in git. Rotate after claiming."
  type        = string
  sensitive   = true
  default     = ""
}

variable "setup_secret" {
  description = "Deliberate authorization for web organization claiming on non-loopback clients (VITAL_SETUP_SECRET). Empty = default gate behavior. Set via TF_VAR_setup_secret, never in git."
  type        = string
  sensitive   = true
  default     = ""
}
