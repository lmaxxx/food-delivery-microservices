# Managed data services. On Floci, each one is a real container.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

variable "name" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

locals {
  # One instance per service: nothing can read another service's tables.
  databases = toset(["auth", "restaurants", "orders", "payments"])
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

# Debezium reads the write-ahead log, which needs logical replication.
# Real RDS honours this parameter. Floci stores it but does not apply it, so
# deploy-local.sh also runs ALTER SYSTEM there, which real RDS would refuse.
resource "aws_db_parameter_group" "logical_replication" {
  name   = "${var.name}-logical-replication"
  family = "postgres17"

  parameter {
    name         = "rds.logical_replication"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "random_password" "database" {
  for_each = local.databases
  length   = 32
  special  = false
}

resource "aws_db_instance" "database" {
  for_each               = local.databases
  identifier             = "${var.name}-${each.key}"
  engine                 = "postgres"
  engine_version         = "17"
  instance_class         = "db.t4g.micro"
  allocated_storage      = 20
  db_name                = each.key
  username               = "${each.key}_user"
  password               = random_password.database[each.key].result
  parameter_group_name   = each.key == "orders" ? aws_db_parameter_group.logical_replication.name : null
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = var.security_group_ids
  skip_final_snapshot    = true
}

resource "aws_msk_cluster" "main" {
  cluster_name           = var.name
  kafka_version          = "3.9.x"
  number_of_broker_nodes = 2

  broker_node_group_info {
    instance_type   = "kafka.t3.small"
    client_subnets  = var.subnet_ids
    security_groups = var.security_group_ids

    storage_info {
      ebs_storage_info {
        volume_size = 20
      }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "PLAINTEXT"
    }
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = var.name
  description          = "Rate limits, courier locations, WebSocket fan-out"
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = var.security_group_ids
}

resource "aws_opensearch_domain" "search" {
  domain_name    = var.name
  engine_version = "OpenSearch_2.19"

  cluster_config {
    instance_type  = "t3.small.search"
    instance_count = 1
  }

  ebs_options {
    ebs_enabled = true
    volume_size = 10
  }
}

output "database_urls" {
  sensitive = true
  value = {
    for name, db in aws_db_instance.database :
    name => "postgresql://${db.username}:${random_password.database[name].result}@${db.endpoint}/${name}?schema=public"
  }
}

output "orders_db" {
  sensitive = true
  value = {
    host     = aws_db_instance.database["orders"].address
    port     = aws_db_instance.database["orders"].port
    user     = aws_db_instance.database["orders"].username
    password = random_password.database["orders"].result
  }
}

output "kafka_brokers" {
  value = aws_msk_cluster.main.bootstrap_brokers
}

output "redis_url" {
  value = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${coalesce(aws_elasticache_replication_group.redis.port, 6379)}"
}

output "search_endpoint" {
  value = aws_opensearch_domain.search.endpoint
}
