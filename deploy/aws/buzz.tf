# Buzz relay on AWS — replaces deploy/docker-compose.buzz.yml (MinIO, local Redis,
# local Postgres). Maps idea.md §17 talk layer to:
#   Buzz relay  -> ECS Fargate + Cloud Map (buzz.vital.local:3000)
#   Buzz Postgres -> RDS Postgres 16 (private, PITR 7d)
#   Buzz cache  -> ElastiCache Redis 7 (auth + TLS)
#   Buzz media  -> S3 (native IAM task role — no MinIO endpoint)

locals {
  buzz_discovery = var.enable_buzz ? "http://buzz.${aws_service_discovery_private_dns_namespace.vital.name}:3000" : ""
}

resource "random_password" "buzz_db" {
  count   = var.enable_buzz ? 1 : 0
  length  = 32
  special = false
}

resource "random_password" "buzz_redis" {
  count   = var.enable_buzz ? 1 : 0
  length  = 32
  special = false
}

resource "aws_security_group" "buzz_rds" {
  count  = var.enable_buzz ? 1 : 0
  name   = "${local.name}-buzz-rds"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }
}

resource "aws_security_group" "buzz_redis" {
  count  = var.enable_buzz ? 1 : 0
  name   = "${local.name}-buzz-redis"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }
}

resource "aws_db_subnet_group" "buzz" {
  count      = var.enable_buzz ? 1 : 0
  name       = "${local.name}-buzz-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "buzz" {
  count                   = var.enable_buzz ? 1 : 0
  identifier              = "${local.name}-buzz"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.buzz_db_instance_class
  allocated_storage       = 20
  storage_type            = "gp3"
  storage_encrypted       = true
  max_allocated_storage   = var.buzz_db_max_allocated_storage
  db_name                 = var.buzz_db_name
  username                = var.buzz_db_username
  password                = random_password.buzz_db[0].result
  multi_az                = var.buzz_db_multi_az
  db_subnet_group_name    = aws_db_subnet_group.buzz[0].name
  vpc_security_group_ids  = [aws_security_group.buzz_rds[0].id]
  backup_retention_period = 7
  copy_tags_to_snapshot   = true
  deletion_protection     = true
  skip_final_snapshot     = true
}

resource "aws_elasticache_subnet_group" "buzz" {
  count      = var.enable_buzz ? 1 : 0
  name       = "${local.name}-buzz-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "buzz" {
  count                      = var.enable_buzz ? 1 : 0
  replication_group_id       = "${local.name}-buzz-redis"
  description                = "Buzz relay cache"
  node_type                  = var.buzz_redis_node_type
  num_cache_clusters         = 1
  engine                     = "redis"
  engine_version             = "7.0"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.buzz[0].name
  security_group_ids         = [aws_security_group.buzz_redis[0].id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.buzz_redis[0].result
  automatic_failover_enabled = false
}

resource "aws_s3_bucket" "buzz_media" {
  count  = var.enable_buzz ? 1 : 0
  bucket = "${local.name}-buzz-media-${data.aws_caller_identity.self.account_id}"
}

resource "aws_s3_bucket_versioning" "buzz_media" {
  count  = var.enable_buzz ? 1 : 0
  bucket = aws_s3_bucket.buzz_media[0].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "buzz_media" {
  count  = var.enable_buzz ? 1 : 0
  bucket = aws_s3_bucket.buzz_media[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "buzz_media" {
  count                   = var.enable_buzz ? 1 : 0
  bucket                  = aws_s3_bucket.buzz_media[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "buzz_media" {
  count  = var.enable_buzz ? 1 : 0
  bucket = aws_s3_bucket.buzz_media[0].id
  rule {
    id     = "prune-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_secretsmanager_secret" "buzz_db_url" {
  count = var.enable_buzz ? 1 : 0
  name  = "${local.name}/buzz-database-url"
}

resource "aws_secretsmanager_secret_version" "buzz_db_url" {
  count         = var.enable_buzz ? 1 : 0
  secret_id     = aws_secretsmanager_secret.buzz_db_url[0].id
  secret_string = "postgres://${var.buzz_db_username}:${random_password.buzz_db[0].result}@${aws_db_instance.buzz[0].address}:5432/${var.buzz_db_name}"
}

resource "aws_secretsmanager_secret" "buzz_redis_url" {
  count = var.enable_buzz ? 1 : 0
  name  = "${local.name}/buzz-redis-url"
}

resource "aws_secretsmanager_secret_version" "buzz_redis_url" {
  count     = var.enable_buzz ? 1 : 0
  secret_id = aws_secretsmanager_secret.buzz_redis_url[0].id
  secret_string = "rediss://:${random_password.buzz_redis[0].result}@${aws_elasticache_replication_group.buzz[0].primary_endpoint_address}:6379"
}

resource "aws_secretsmanager_secret" "buzz_relay_key" {
  count = var.enable_buzz ? 1 : 0
  name  = "${local.name}/buzz-relay-private-key"
}

resource "aws_secretsmanager_secret_version" "buzz_relay_key" {
  count         = var.enable_buzz ? 1 : 0
  secret_id     = aws_secretsmanager_secret.buzz_relay_key[0].id
  secret_string = var.buzz_relay_private_key
}

resource "aws_iam_policy" "buzz_task" {
  count = var.enable_buzz ? 1 : 0
  name  = "${local.name}-buzz-task"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.buzz_media[0].arn, "${aws_s3_bucket.buzz_media[0].arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.buzz_db_url[0].arn,
          aws_secretsmanager_secret.buzz_redis_url[0].arn,
          aws_secretsmanager_secret.buzz_relay_key[0].arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.buzz[0].arn}:*"]
      }
    ]
  })
}

resource "aws_iam_role" "buzz_task" {
  count = var.enable_buzz ? 1 : 0
  name  = "${local.name}-buzz-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "buzz_task" {
  count      = var.enable_buzz ? 1 : 0
  role       = aws_iam_role.buzz_task[0].name
  policy_arn = aws_iam_policy.buzz_task[0].arn
}

resource "aws_cloudwatch_log_group" "buzz" {
  count             = var.enable_buzz ? 1 : 0
  name              = "/vital/buzz"
  retention_in_days = 90
}

resource "aws_service_discovery_service" "buzz" {
  count = var.enable_buzz ? 1 : 0
  name  = "buzz"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.vital.id
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

resource "aws_lb_target_group" "buzz" {
  count       = var.enable_buzz ? 1 : 0
  name        = "${local.name}-buzz"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    port                = "8080"
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_listener_rule" "buzz_host" {
  count        = var.enable_buzz && var.buzz_hostname != "" ? 1 : 0
  listener_arn = var.acm_certificate_arn == "" ? aws_lb_listener.http.arn : aws_lb_listener.https[0].arn
  priority     = 20
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.buzz[0].arn
  }
  condition {
    host_header {
      values = [var.buzz_hostname]
    }
  }
}

resource "aws_ecs_task_definition" "buzz" {
  count                    = var.enable_buzz ? 1 : 0
  family                   = "${local.name}-buzz"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.buzz_cpu
  memory                   = var.buzz_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.buzz_task[0].arn
  container_definitions = jsonencode([
    {
      name         = "buzz-relay"
      image        = var.buzz_image
      essential    = true
      portMappings = [
        { containerPort = 3000, protocol = "tcp" },
        { containerPort = 8080, protocol = "tcp" }
      ]
      environment = [
        { name = "BUZZ_BIND_ADDR", value = "0.0.0.0:3000" },
        { name = "BUZZ_HEALTH_PORT", value = "8080" },
        { name = "BUZZ_METRICS_PORT", value = "9102" },
        { name = "BUZZ_S3_BUCKET", value = aws_s3_bucket.buzz_media[0].bucket },
        { name = "AWS_REGION", value = var.region },
        { name = "BUZZ_AUTO_MIGRATE", value = "true" },
        { name = "BUZZ_GIT_CONFORMANCE_PROBE", value = "false" },
        { name = "BUZZ_REQUIRE_AUTH_TOKEN", value = "true" },
        { name = "BUZZ_SERVE_GIT_WEB_GUI", value = "false" },
        { name = "RUST_LOG", value = "buzz_relay=info,buzz_db=info,tower_http=info" }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.buzz_db_url[0].arn },
        { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.buzz_redis_url[0].arn },
        { name = "BUZZ_RELAY_PRIVATE_KEY", valueFrom = aws_secretsmanager_secret.buzz_relay_key[0].arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.buzz[0].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "relay"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "buzz" {
  count           = var.enable_buzz ? 1 : 0
  name            = "${local.name}-buzz"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.buzz[0].arn
  desired_count   = var.buzz_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.buzz[0].arn
    container_name   = "buzz-relay"
    container_port   = 3000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.buzz[0].arn
  }
  depends_on = [aws_lb_listener.http]
}
