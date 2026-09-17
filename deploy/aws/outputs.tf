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
