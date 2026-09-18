output "alb_dns" {
  description = "Public entry: webhooks + console + Slack fallback all ride this ALB"
  value       = aws_lb.main.dns_name
}

output "core_ecr" {
  value = aws_ecr_repository.core.repository_url
}

output "executor_ecr" {
  value = aws_ecr_repository.executor.repository_url
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
    var.acm_certificate_arn == "" ? "http://${var.buzz_hostname}" : "https://${var.buzz_hostname}"
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
