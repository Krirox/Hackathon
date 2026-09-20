output "alb_dns" {
  description = "Public entry: webhooks + console + Slack fallback all ride this ALB"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone id of the ALB itself — the alias target's zone. Route 53 needs it alongside alb_dns, and DNS managed outside this stack needs it too."
  value       = aws_lb.main.zone_id
}

output "console_url" {
  description = "Console entry point: https://<domain_name> when domain_name is set, otherwise the raw ALB DNS. With only acm_certificate_arn set, reach the console through the hostname that certificate covers — the raw ALB DNS name is not on it."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_lb.main.dns_name}"
}

output "console_certificate_arn" {
  description = "Certificate the HTTPS listener presents: the explicit var.acm_certificate_arn, or the one created for var.domain_name. Null when no TLS is configured."
  value       = local.certificate_arn
}

output "console_hosted_zone_id" {
  description = "Route 53 zone holding the console records (null when domain_name is empty)"
  value       = local.dns_enabled == 1 ? data.aws_route53_zone.main[0].zone_id : null
}

output "cluster_name" {
  description = "ECS cluster holding core, Buzz and the staged jcode service"
  value       = aws_ecs_cluster.main.name
}

output "core_service" {
  description = "core ECS service name — what `aws ecs wait services-stable --cluster <cluster_name> --services <this>` waits on"
  value       = aws_ecs_service.core.name
}

output "core_ecr" {
  value = local.core_repo_url
}

output "executor_ecr" {
  value = local.executor_repo_url
}

output "rds_endpoint" {
  description = "Ledger Postgres endpoint (private; core + Lambda only)"
  value       = aws_db_instance.ledger.address
}

output "requests_queue_url" {
  value = aws_sqs_queue.requests.url
}

output "executor_dlq_url" {
  value = aws_sqs_queue.executor_dlq.url
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "audit_bucket" {
  description = "Immutable audit copy (Object Lock, COMPLIANCE 365d)"
  value       = aws_s3_bucket.audit.bucket
}

output "executor_function" {
  value = aws_lambda_function.executor.function_name
}

output "jcode_service" {
  description = "Staged jcode split: count 0 in socket mode, jcode_desired_count once jcode_target = tcp"
  value       = aws_ecs_service.jcode.name
}

output "jcode_discovery" {
  description = "Private DNS name the TCP-stage core would dial (staged; JcodeClient has no host:port yet)"
  value       = "${aws_service_discovery_service.jcode.name}.${aws_service_discovery_private_dns_namespace.vital.name}"
}

output "ops_topic" {
  value = aws_sns_topic.ops.arn
}

output "buzz_relay_internal_url" {
  description = "Private Cloud Map URL vital-core uses (BUZZ_RELAY_URL)"
  value       = var.enable_buzz ? local.buzz_discovery : null
}

output "buzz_relay_public_url" {
  description = "Public relay URL when buzz_hostname is set on the ALB; otherwise null"
  value = var.enable_buzz && var.buzz_hostname != "" ? (
    local.tls_enabled == 0 ? "http://${var.buzz_hostname}" : "https://${var.buzz_hostname}"
  ) : null
}

output "buzz_media_bucket" {
  value = var.enable_buzz ? aws_s3_bucket.buzz_media[0].bucket : null
}

output "buzz_rds_endpoint" {
  description = "Buzz Postgres endpoint (private; Buzz ECS only)"
  value       = var.enable_buzz ? aws_db_instance.buzz[0].address : null
}

output "buzz_service" {
  value = var.enable_buzz ? aws_ecs_service.buzz[0].name : null
}
