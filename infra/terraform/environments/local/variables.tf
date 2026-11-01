variable "environment" {
  description = "Environment name, used as a suffix on resource names."
  type        = string
  default     = "local"
}

variable "region" {
  description = "AWS region. Floci accepts any published region."
  type        = string
  default     = "eu-central-1"
}

variable "floci_endpoint" {
  description = "URL of the local Floci emulator."
  type        = string
  default     = "http://localhost:4566"
}

variable "image" {
  description = "Local image shared by the NestJS services."
  type        = string
  default     = "food-delivery/app:local"
}

variable "run_services" {
  description = "Start the NestJS services. deploy-local.sh sets this after schemas exist."
  type        = bool
  default     = false
}
