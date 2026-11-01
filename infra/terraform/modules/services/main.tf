# Every workload as an ECS Fargate service: IAM, secrets, logs, discovery, load balancer.
# Internal services find each other through Cloud Map DNS, as <name>.<namespace>.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    tls = {
      source = "hashicorp/tls"
    }
  }
}

variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "image" {
  description = "Image shared by the NestJS services."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "load_balancer_security_group_id" {
  type = string
}

variable "database_urls" {
  type      = map(string)
  sensitive = true
}

variable "kafka_brokers" {
  type = string
}

variable "redis_url" {
  type = string
}

variable "search_url" {
  type = string
}

variable "rate_limit_per_second" {
  description = "Gateway rate limit per client, for both capacity and refill. Null keeps the app default."
  type        = number
  default     = null
}

variable "payment_delay_ms" {
  description = "Simulated card network delay in Payment."
  type        = number
  default     = 0
}

variable "saga_restaurant_timeout_ms" {
  description = "How long an order may wait for the kitchen. Null keeps the app default."
  type        = number
  default     = null
}

variable "payment_count" {
  description = "Number of Payment tasks."
  type        = number
  default     = 1
}

variable "run_services" {
  description = "False creates everything but the services, so schemas can be set up first."
  type        = bool
}

resource "tls_private_key" "jwt" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "food.internal"
  vpc  = var.vpc_id
}

locals {
  namespace = aws_service_discovery_private_dns_namespace.main.name

  shared = {
    KAFKA_BROKERS     = var.kafka_brokers
    REDIS_URL         = var.redis_url
    ELASTICSEARCH_URL = var.search_url
    CLICKHOUSE_URL    = "http://clickhouse.${local.namespace}:8123"
    SMTP_HOST         = "mailpit.${local.namespace}"
    ORDER_GRPC_URL    = "order.${local.namespace}:50051"
    AUTH_URL          = "http://auth.${local.namespace}:3001"
    RESTAURANT_URL    = "http://restaurant.${local.namespace}:3002"
    DELIVERY_URL      = "http://delivery.${local.namespace}:3005"
    SEARCH_URL        = "http://search-indexer.${local.namespace}:3007"
    ANALYTICS_URL     = "http://analytics.${local.namespace}:3008"
    JWT_PUBLIC_KEY    = tls_private_key.jwt.public_key_pem
  }

  rate_limit_env = var.rate_limit_per_second == null ? {} : {
    RATE_CAPACITY      = tostring(var.rate_limit_per_second)
    RATE_REFILL        = tostring(var.rate_limit_per_second)
    RATE_AUTH_CAPACITY = tostring(var.rate_limit_per_second)
    RATE_AUTH_REFILL   = tostring(var.rate_limit_per_second)
  }

  node_services = {
    api-gateway    = { port = 4400, count = 1, extra = merge({ TRUSTED_PROXIES = "1" }, local.rate_limit_env), secrets = {} }
    ws-gateway     = { port = 3010, count = 2, extra = {}, secrets = {} }
    auth           = { port = 3001, count = 1, extra = {}, secrets = { DATABASE_URL = "auth", JWT_PRIVATE_KEY = "jwt" } }
    restaurant     = { port = 3002, count = 1, extra = {}, secrets = { DATABASE_URL = "restaurants" } }
    order          = { port = 3003, count = 1, extra = var.saga_restaurant_timeout_ms == null ? {} : { SAGA_RESTAURANT_TIMEOUT_MS = tostring(var.saga_restaurant_timeout_ms) }, secrets = { DATABASE_URL = "orders" } }
    payment        = { port = 3004, count = var.payment_count, extra = { PAYMENT_DELAY_MS = tostring(var.payment_delay_ms) }, secrets = { DATABASE_URL = "payments" } }
    delivery       = { port = 3005, count = 1, extra = {}, secrets = {} }
    notification   = { port = 3006, count = 1, extra = {}, secrets = {} }
    search-indexer = { port = 3007, count = 1, extra = {}, secrets = {} }
    analytics      = { port = 3008, count = 1, extra = {}, secrets = {} }
  }

  # No AWS service is used for these in this deployment, so they run as plain tasks.
  support_services = {
    clickhouse = {
      image  = "clickhouse/clickhouse-server:24.8-alpine"
      port   = 8123
      memory = 1024
      env = {
        CLICKHOUSE_USER                      = "default"
        CLICKHOUSE_PASSWORD                  = ""
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT = "1"
      }
    }
    mailpit = {
      image  = "axllent/mailpit:v1.21"
      port   = 1025
      memory = 1024
      env    = {}
    }
    debezium = {
      image  = "quay.io/debezium/connect:3.0"
      port   = 8083
      memory = 1024
      env = {
        BOOTSTRAP_SERVERS    = var.kafka_brokers
        GROUP_ID             = "debezium"
        CONFIG_STORAGE_TOPIC = "_connect_configs"
        OFFSET_STORAGE_TOPIC = "_connect_offsets"
        STATUS_STORAGE_TOPIC = "_connect_status"
      }
    }
  }

  secret_values = merge(var.database_urls, { jwt = tls_private_key.jwt.private_key_pem })
  # Written out because Terraform refuses to loop over names derived from a sensitive map.
  secret_names  = toset(["auth", "restaurants", "orders", "payments", "jwt"])
  all_workloads = toset(concat(keys(local.node_services), keys(local.support_services)))
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secret_names
  name                    = "${var.name}/${each.key}"
  recovery_window_in_days = 0
}

# Terraform state contains these values in plain text, so state itself is a secret.
resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secret_names
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = local.secret_values[each.key]
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.all_workloads
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# Least privilege: pull images, write logs, and read this project's secrets only.
data "aws_iam_policy_document" "execution" {
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = ["*"]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for group in aws_cloudwatch_log_group.service : "${group.arn}:*"]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for secret in aws_secretsmanager_secret.app : secret.arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

resource "aws_ecs_task_definition" "node" {
  for_each                 = local.node_services
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name             = each.key
      image            = var.image
      essential        = true
      workingDirectory = "/repo/apps/${each.key}"
      command          = ["node", "-r", "@swc-node/register", "src/main.ts"]
      portMappings     = [{ containerPort = each.value.port, protocol = "tcp" }]
      environment = [
        for key, value in merge(local.shared, each.value.extra, { PORT = tostring(each.value.port) }) :
        { name = key, value = value }
      ]
      secrets = [
        for key, secret in each.value.secrets :
        { name = key, valueFrom = aws_secretsmanager_secret.app[secret].arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_task_definition" "support" {
  for_each                 = local.support_services
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name         = each.key
      image        = each.value.image
      essential    = true
      portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
      environment  = [for key, value in each.value.env : { name = key, value = value }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_service_discovery_service" "workload" {
  for_each = local.all_workloads
  name     = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      type = "A"
      ttl  = 5
    }
  }
}

resource "aws_lb" "public" {
  name               = "food-delivery-public"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [var.load_balancer_security_group_id]
}

resource "aws_lb_target_group" "gateway" {
  for_each    = { api-gateway = 4400, ws-gateway = 3010 }
  name        = each.key
  port        = each.value
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path     = "/health"
    interval = 10
  }
}

resource "aws_lb_listener" "gateway" {
  for_each          = { api-gateway = 4400, ws-gateway = 3010 }
  load_balancer_arn = aws_lb.public.arn
  port              = each.value
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway[each.key].arn
  }
}

resource "aws_ecs_service" "node" {
  for_each        = var.run_services ? local.node_services : {}
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.node[each.key].arn
  desired_count   = each.value.count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [var.security_group_id]
  }

  service_registries {
    registry_arn = aws_service_discovery_service.workload[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = contains(keys(aws_lb_target_group.gateway), each.key) ? [each.key] : []
    content {
      target_group_arn = aws_lb_target_group.gateway[load_balancer.value].arn
      container_name   = load_balancer.value
      container_port   = each.value.port
    }
  }

  depends_on = [aws_lb_listener.gateway, aws_ecs_service.support]
}

# Runs even when run_services is false: schema setup needs ClickHouse and Debezium.
resource "aws_ecs_service" "support" {
  for_each        = local.support_services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.support[each.key].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [var.security_group_id]
  }

  service_registries {
    registry_arn = aws_service_discovery_service.workload[each.key].arn
  }
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}
