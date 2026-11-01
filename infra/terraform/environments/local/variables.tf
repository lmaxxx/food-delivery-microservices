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

variable "rate_limit_per_second" {
  description = "Raised during load experiments, so tests measure the system and not the limiter."
  type        = number
  default     = null
}

variable "payment_delay_ms" {
  description = "Simulated card network delay, used by the scaling experiment."
  type        = number
  default     = 0
}

variable "payment_count" {
  description = "Number of Payment tasks, used by the scaling experiment."
  type        = number
  default     = 1
}

variable "saga_restaurant_timeout_ms" {
  description = "Raised during load experiments, where no kitchen accepts orders. Null keeps the app default."
  type        = number
  default     = null
}
