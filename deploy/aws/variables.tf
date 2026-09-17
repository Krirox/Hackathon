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
  description = "vital-core Fargate tasks behind the ALB"
  type        = number
  default     = 2
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

variable "tags" {
  description = "Extra tags merged onto every resource"
  type        = map(string)
  default     = {}
}
