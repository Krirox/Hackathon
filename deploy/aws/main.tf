# Vital on AWS — all-in-one stack.
#
# Maps to idea.md §17 (VPS-1 Buzz · VPS-2 core+PG · VPS-3 jcode) as:
#   Buzz relay            -> ECS Fargate service (talk layer, own Nostr relay)
#   Vital core + Postgres -> ECS Fargate service + RDS Postgres 16 (PITR on)
#   jcode sibling         -> sidecar container in the core task (localhost socket,
#                            same REQUEST/bid path as src/jcode/runner.ts — coordinated, not mounted)
#   Ephemeral workers     -> Lambda container image (Firecracker microVMs) on SQS,
#                            15-min cap; anything longer stays on the jcode sidecar.
#   Raw artifacts         -> S3 (content-addressed, like data/artifacts/<sha256>)
#   Immutable audit copy  -> second S3 bucket with Object Lock (separate from the Ledger,
#                            so a compromised runtime cannot erase its trail — idea.md §12)
#
# Webhooks reach core through the ALB (WEBHOOK_SECRET auth already in
# src/substrate/scheduler.ts). Slack HMAC fallback rides the same ALB
# (src/talk/surface.ts). Egress policy is decided in code in exactly one place
# (src/substrate/egress.ts, enforced here + in the Lambda); SGs/NAT are the
# backstop, never the policy.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Project = "vital", ManagedBy = "terraform" }, var.tags)
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = var.project
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

# ------------------------------------------------------------- networking ----
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs" {
  name   = "${local.name}-ecs"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3100
    to_port         = 3100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  # EFS mount targets carry this SG: NFS needs TCP 2049 or the sandbox
  # volume mount hangs at task startup. Self-ingress only — no open NFS.
  ingress {
    from_port = 2049
    to_port   = 2049
    protocol  = "tcp"
    self      = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name   = "${local.name}-rds"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id, aws_security_group.lambda.id]
  }
}

resource "aws_security_group" "lambda" {
  name   = "${local.name}-lambda"
  vpc_id = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ------------------------------------------------------------------ images ----
resource "aws_ecr_repository" "core" {
  name                 = "${local.name}-core"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_repository" "executor" {
  name                 = "${local.name}-executor"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "core" {
  repository = aws_ecr_repository.core.name
  policy     = jsonencode({ rules = [{ rulePriority = 1, description = "keep last 20", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }, action = { type = "expire" } }] })
}

# ------------------------------------------------------------------ secrets ---
resource "aws_secretsmanager_secret" "tenant_hmac" { name = "${local.name}/tenant-hmac-secret" }
resource "aws_secretsmanager_secret_version" "tenant_hmac" {
  secret_id     = aws_secretsmanager_secret.tenant_hmac.id
  secret_string = var.tenant_hmac_secret
}
resource "aws_secretsmanager_secret" "core_secret" { name = "${local.name}/core-secret" }
resource "aws_secretsmanager_secret_version" "core_secret" {
  secret_id     = aws_secretsmanager_secret.core_secret.id
  secret_string = var.vital_core_secret
}
resource "aws_secretsmanager_secret" "webhook" { name = "${local.name}/webhook-secret" }
resource "aws_secretsmanager_secret_version" "webhook" {
  secret_id     = aws_secretsmanager_secret.webhook.id
  secret_string = var.webhook_secret
}
resource "aws_secretsmanager_secret" "serper" { name = "${local.name}/serper-api-key" }
resource "aws_secretsmanager_secret_version" "serper" {
  secret_id     = aws_secretsmanager_secret.serper.id
  secret_string = var.serper_api_key
}
resource "aws_secretsmanager_secret" "gemini" { name = "${local.name}/gemini-api-key" }
resource "aws_secretsmanager_secret_version" "gemini" {
  secret_id     = aws_secretsmanager_secret.gemini.id
  secret_string = var.gemini_api_key
}
resource "aws_secretsmanager_secret" "novita" { name = "${local.name}/novita-api-key" }
resource "aws_secretsmanager_secret_version" "novita" {
  secret_id     = aws_secretsmanager_secret.novita.id
  secret_string = var.novita_api_key
}

resource "random_password" "db" {
  length  = 32
  special = false
}

# ----------------------------------------------------------------- database ---
resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "ledger" {
  identifier              = "${local.name}-ledger"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  storage_type            = "gp3"
  storage_encrypted       = true
  db_name                 = var.db_name
  username                = var.db_username
  password                = random_password.db.result
  multi_az                = var.db_multi_az
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  backup_retention_period = 7
  copy_tags_to_snapshot   = true
  deletion_protection     = true
  # skip_final_snapshot must be true unless final_snapshot_identifier is set
  # (apply errors otherwise); automated backups + manual snapshots remain.
  skip_final_snapshot = true
}

# ------------------------------------------------------------------ storage ---
resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.name}-artifacts-${data.aws_caller_identity.self.account_id}"
}

data "aws_caller_identity" "self" {}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Immutable audit copy — Object Lock so a compromised runtime cannot rewrite history.
resource "aws_s3_bucket" "audit" {
  bucket              = "${local.name}-audit-${data.aws_caller_identity.self.account_id}"
  object_lock_enabled = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = 365
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --------------------------------------------------------------------- queue ---
resource "aws_sqs_queue" "executor_dlq" {
  name = "${local.name}-executor-dlq"
}

resource "aws_sqs_queue" "requests" {
  name                       = "${local.name}-requests"
  visibility_timeout_seconds = 900
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.executor_dlq.arn
    maxReceiveCount     = 3
  })
}

# ------------------------------------------------------------------- efs ------
# Rebuildable sandbox scopes live here (src/substrate/sandbox.ts manifests are
# the ground truth; EFS is the cache, never trust-bearing).
resource "aws_efs_file_system" "sandboxes" {
  creation_token = "${local.name}-sandboxes"
  encrypted      = true
}

resource "aws_efs_mount_target" "sandboxes" {
  count           = var.az_count
  file_system_id  = aws_efs_file_system.sandboxes.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.ecs.id]
}

resource "aws_efs_access_point" "sandboxes" {
  file_system_id = aws_efs_file_system.sandboxes.id
  posix_user {
    gid = 1000
    uid = 1000
  }
  root_directory {
    path = "/vital-sandboxes"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "750"
    }
  }
}

# --------------------------------------------------------------------- iam ----
resource "aws_iam_role" "ecs_execution" {
  name = "${local.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_policy" "ecs_task" {
  name = "${local.name}-ecs-task"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [
        aws_secretsmanager_secret.tenant_hmac.arn, aws_secretsmanager_secret.core_secret.arn,
        aws_secretsmanager_secret.webhook.arn, aws_secretsmanager_secret.serper.arn,
        aws_secretsmanager_secret.gemini.arn, aws_secretsmanager_secret.novita.arn
      ] },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = [
        "${aws_s3_bucket.artifacts.arn}/*", "${aws_s3_bucket.audit.arn}/*"
      ] },
      { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.requests.arn] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = ["${aws_cloudwatch_log_group.core.arn}:*"] }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ecs_task.arn
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-executor"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_policy" "lambda" {
  name = "${local.name}-executor"
  # No Secrets Manager grant: secret VALUES are injected as env at deploy
  # time (see executor environment block). The function never fetches
  # secrets at runtime, so it must not be able to.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.requests.arn] }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_extra" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.lambda.arn
}

# --------------------------------------------------------------------- logs ---
resource "aws_cloudwatch_log_group" "core" {
  name              = "/vital/core"
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "executor" {
  name              = "/vital/executor"
  retention_in_days = 90
}

# ----------------------------------------------------------------- core svc ---
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_lb" "main" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "core" {
  name        = "${local.name}-core"
  port        = 3100
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path                = "/api/approval-latency"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.core.arn
  }
}

resource "aws_ecs_task_definition" "core" {
  family                   = "${local.name}-core"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.core_cpu
  memory                   = var.core_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn
  volume { name = "jcode-sock" }
  volume {
    name = "sandboxes"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.sandboxes.id
      transit_encryption = "ENABLED"
      authorization_config { access_point_id = aws_efs_access_point.sandboxes.id }
    }
  }
  container_definitions = jsonencode([
    {
      name         = "vital-core"
      image        = var.core_image
      essential    = true
      portMappings = [{ containerPort = 3100, protocol = "tcp" }]
      mountPoints = [
        { sourceVolume = "sandboxes", containerPath = "/var/vital/sandboxes" },
        { sourceVolume = "jcode-sock", containerPath = "/run" }
      ]
      environment = [
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "3100" },
        { name = "VITAL_TENANT", value = "acme" },
        { name = "TALK_SURFACE", value = "buzz" },
        { name = "JCODE_API_SOCKET", value = "/run/jcode-api.sock" },
        { name = "ARTIFACT_DIR", value = "/var/vital/sandboxes/artifacts" },
        { name = "ALLOWED_EGRESS_HOSTS", value = var.allowed_egress_hosts }
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.db_url.arn}" },
        { name = "TENANT_HMAC_SECRET", valueFrom = aws_secretsmanager_secret.tenant_hmac.arn },
        { name = "VITAL_CORE_SECRET", valueFrom = aws_secretsmanager_secret.core_secret.arn },
        { name = "WEBHOOK_SECRET", valueFrom = aws_secretsmanager_secret.webhook.arn },
        { name = "SERPER_API_KEY", valueFrom = aws_secretsmanager_secret.serper.arn },
        { name = "GEMINI_API_KEY", valueFrom = aws_secretsmanager_secret.gemini.arn },
        { name = "NOVITA_API_KEY", valueFrom = aws_secretsmanager_secret.novita.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.core.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "core"
        }
      }
    },
    {
      name        = "jcode"
      image       = var.jcode_image
      essential   = false
      mountPoints = [{ sourceVolume = "jcode-sock", containerPath = "/run" }]
      environment = [{ name = "JCODE_API_SOCKET", value = "/run/jcode-api.sock" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.core.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "jcode"
        }
      }
    }
  ])
}

resource "aws_secretsmanager_secret" "db_url" { name = "${local.name}/database-url" }
resource "aws_secretsmanager_secret_version" "db_url" {
  secret_id     = aws_secretsmanager_secret.db_url.id
  secret_string = "postgres://${var.db_username}:${random_password.db.result}@${aws_db_instance.ledger.address}:5432/${var.db_name}"
}

resource "aws_ecs_service" "core" {
  name            = "${local.name}-core"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.core.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.core.arn
    container_name   = "vital-core"
    container_port   = 3100
  }
  depends_on = [aws_lb_listener.http]
}

# ------------------------------------------------------- lambda executors ----
# Firecracker-microVM plane: one microVM per invocation, 15-min cap, SQS-driven.
# Reserved concurrency is the infra-layer budget-death backstop (var).
resource "aws_lambda_function" "executor" {
  function_name = "${local.name}-executor"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.executor_image
  timeout       = 900
  memory_size   = var.lambda_memory_mb
  ephemeral_storage { size = 10240 }
  reserved_concurrent_executions = var.lambda_reserved_concurrency > 0 ? var.lambda_reserved_concurrency : null
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }
  environment {
    variables = {
      VITAL_TENANT         = "acme"
      ALLOWED_EGRESS_HOSTS = var.allowed_egress_hosts
      APPROVED_PROD_MODELS = "deepseek/deepseek-v4"
      APPROVED_DEV_MODELS  = "gemini-3.8-flash"
      ARTIFACT_BUCKET      = aws_s3_bucket.artifacts.bucket
      # Without these the handler falls back to sqlite :memory: and keyless
      # model calls — every job fails at coord.get. Values ride TF state
      # (sensitive); rotation = new secret version + re-apply.
      DATABASE_URL   = aws_secretsmanager_secret_version.db_url.secret_string
      GEMINI_API_KEY = aws_secretsmanager_secret_version.gemini.secret_string
      NOVITA_API_KEY = aws_secretsmanager_secret_version.novita.secret_string
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.executor.name
  }
}

resource "aws_lambda_event_source_mapping" "executor" {
  event_source_arn = aws_sqs_queue.requests.arn
  function_name    = aws_lambda_function.executor.arn
  batch_size       = 1
}

# ------------------------------------------------------------------- ops -----
resource "aws_sns_topic" "ops" { name = "${local.name}-ops" }

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.name}-executor-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { FunctionName = aws_lambda_function.executor.function_name }
  alarm_actions       = [aws_sns_topic.ops.arn]
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { QueueName = aws_sqs_queue.requests.name }
  alarm_actions       = [aws_sns_topic.ops.arn]
}
