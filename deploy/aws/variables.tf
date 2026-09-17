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
}

variable "executor_image" {
  description = "ECR image URI for the Lambda executor container"
  type        = string
  default     = ""
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

variable "tenant_hmac_secret" {
  description = "TALK HMAC secret (talk surface fallback). Set via TF_VAR_*, never in git."
  type        = string
  sensitive   = true
  default     = "CHANGEME"
}

variable "vital_core_secret" {
  description = "Core secret minting scope tokens (substrate/identity)"
  type        = string
  sensitive   = true
  default     = "CHANGEME"
}

variable "webhook_secret" {
  description = "Shared secret for scheduler webhook intake"
  type        = string
  sensitive   = true
  default     = "CHANGEME"
}

variable "serper_api_key" {
  type      = string
  sensitive = true
  default   = "CHANGEME"
}

variable "gemini_api_key" {
  type      = string
  sensitive = true
  default   = "CHANGEME"
}

variable "novita_api_key" {
  type      = string
  sensitive = true
  default   = "CHANGEME"
}

variable "allowed_egress_hosts" {
  description = "Comma-separated allowlist enforced in code (decideEgress) by core + Lambda executor"
  type        = string
  default     = "api.novita.ai,generativelanguage.googleapis.com,api.serper.dev"
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
  description = "ACM cert for ALB HTTPS. Empty = HTTP-forward (dev only): approvals travel in plaintext and must never carry production authority. Set for any pilot."
  type        = string
  default     = ""
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

variable "tags" {
  description = "Extra tags merged onto every resource"
  type        = map(string)
  default     = {}
}
