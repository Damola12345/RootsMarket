# 🌱 RootsMarket

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)
![License](https://img.shields.io/badge/License-MIT-green)
![Status](https://img.shields.io/badge/Status-Active%20Development-orange)

A cloud-native microservices platform that simulates an online African grocery marketplace.

RootsMarket is being developed  to explore modern platform engineering practices including distributed systems, event-driven architecture, observability, containerization, and Kubernetes.


## Overview

The platform demonstrates how modern cloud-native applications are designed, deployed, and operated using independently deployable microservices.

Key engineering concepts include:

- Microservices
- Event-Driven Architecture
- Docker
- RabbitMQ
- Redis
- PostgreSQL
- Observability
- Kubernetes 

## Why RootsMarket?

Modern backend systems are no longer monolithic. They rely on distributed services, asynchronous messaging, observability, automation, and resilient infrastructure.

RootsMarket provides a practical environment for exploring these engineering practices while documenting the architectural decisions and engineering trade-offs involved in building modern cloud-native systems.

## Technology Stack

| Layer | Technology |
|--------|------------|
| Frontend | React, Vite |
| Backend | Node.js, Express |
| Database | PostgreSQL |
| Cache | Redis |
| Messaging | RabbitMQ |
| Containers | Docker, Docker Compose |
| Observability | Prometheus, Grafana, Loki, OpenTelemetry |
| Orchestration | Kubernetes |

## Quick Start

### Prerequisites

- Docker
- Docker Compose

```bash
git clone https://github.com/<your-username>/RootsMarket.git

cd RootsMarket

docker compose up --build
```

Stop the platform:

```bash
docker compose down
```

## Application URLs

| Component | URL |
|-----------|-----|
| Customer Store | http://localhost:3000 |
| RabbitMQ Management | http://localhost:15672 |
| Health Endpoints | http://localhost:3001/health – http://localhost:3005/health
