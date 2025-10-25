.DEFAULT_GOAL := help
.PHONY: help install check clean rebuild link unlink run restart stop test dev status logs fix-permissions setup docs docs-check docs-deploy env clean-env

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

# Paths
N8N_CUSTOM_DIR := $(HOME)/.n8n/custom
PACKAGE_NAME := n8n-nodes-pipelex

# Required pnpm version
REQUIRED_PNPM_VERSION := 10.18.1

# Python environment for docs
PYTHON_VERSION := 3.11
VIRTUAL_ENV := $(CURDIR)/.venv
VENV_PYTHON := $(VIRTUAL_ENV)/bin/python
VENV_PIP := $(VIRTUAL_ENV)/bin/pip
VENV_MKDOCS := $(VIRTUAL_ENV)/bin/mkdocs

# Helper function to print titles
define PRINT_TITLE
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)$(1)$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
endef

install:
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)                    Installing Dependencies$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
	@echo "$(YELLOW)Checking pnpm installation...$(NC)"
	@if command -v pnpm >/dev/null 2>&1; then \
		CURRENT_VERSION=$$(pnpm --version); \
		echo "$(GREEN)✓ pnpm is installed (version $$CURRENT_VERSION)$(NC)"; \
		if [ "$$CURRENT_VERSION" != "$(REQUIRED_PNPM_VERSION)" ]; then \
			echo "$(YELLOW)⚠ Current version ($$CURRENT_VERSION) differs from required version ($(REQUIRED_PNPM_VERSION))$(NC)"; \
			echo "$(YELLOW)Installing pnpm $(REQUIRED_PNPM_VERSION)...$(NC)"; \
			npm install -g pnpm@$(REQUIRED_PNPM_VERSION); \
		fi; \
	else \
		echo "$(YELLOW)pnpm not found. Installing pnpm $(REQUIRED_PNPM_VERSION)...$(NC)"; \
		npm install -g pnpm@$(REQUIRED_PNPM_VERSION); \
		echo "$(GREEN)✓ pnpm $(REQUIRED_PNPM_VERSION) installed$(NC)"; \
	fi
	@echo ""
	@echo "$(YELLOW)Installing project dependencies...$(NC)"
	@pnpm install
	@echo ""
	@echo "$(GREEN)✓ Installation complete!$(NC)"
	@echo ""

check:
	@echo "$(BLUE)Running quality checks...$(NC)"
	@pnpm run lint
	@pnpm run build
	@echo "$(YELLOW)Running n8n scanner...$(NC)"
	@npx --yes @n8n/scan-community-package n8n-nodes-pipelex || echo "$(YELLOW)Note: Scanner requires published package$(NC)"
	@echo "$(GREEN)✓ All checks passed$(NC)"

help:
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)                    Pipelex n8n Node - Development Tools$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
	@echo "$(YELLOW)Quick Start:$(NC)"
	@echo "  $(GREEN)make install$(NC)        Install pnpm (10.18.1) and dependencies"
	@echo "  $(GREEN)make check$(NC)          Run all quality checks (lint, build, validate)"
	@echo "  $(GREEN)make setup$(NC)          Build and link the node for local testing"
	@echo "  $(GREEN)make run$(NC)            Rebuild and start n8n (interactive mode)"
	@echo "  $(GREEN)make restart$(NC)        Rebuild and start n8n in background"
	@echo ""
	@echo "$(YELLOW)Development:$(NC)"
	@echo "  $(GREEN)make rebuild$(NC)        Clean and rebuild the project"
	@echo "  $(GREEN)make dev$(NC)            Watch mode - auto rebuild on file changes"
	@echo "  $(GREEN)make clean$(NC)          Remove all build artifacts"
	@echo ""
	@echo "$(YELLOW)Testing & Linking:$(NC)"
	@echo "  $(GREEN)make link$(NC)           Build and link package to n8n"
	@echo "  $(GREEN)make unlink$(NC)         Remove package from n8n"
	@echo "  $(GREEN)make test$(NC)           Link and run n8n for testing"
	@echo ""
	@echo "$(YELLOW)n8n Control:$(NC)"
	@echo "  $(GREEN)make status$(NC)         Check if n8n is running"
	@echo "  $(GREEN)make stop$(NC)           Stop n8n background process"
	@echo "  $(GREEN)make logs$(NC)           Show n8n logs (tail -f)"
	@echo ""
	@echo "$(YELLOW)Documentation:$(NC)"
	@echo "  $(GREEN)make env$(NC)            Create Python venv and install docs dependencies"
	@echo "  $(GREEN)make docs$(NC)           Serve documentation locally with mkdocs"
	@echo "  $(GREEN)make docs-check$(NC)     Check documentation build with mkdocs"
	@echo "  $(GREEN)make docs-deploy$(NC)    Deploy documentation to GitHub Pages"
	@echo "  $(GREEN)make clean-env$(NC)      Remove Python virtual environment"
	@echo ""
	@echo "$(YELLOW)Direct Commands:$(NC)"
	@echo "  pnpm install         Install dependencies"
	@echo "  pnpm run build       Build the project"
	@echo "  pnpm run lint        Run ESLint"
	@echo "  pnpm run format      Format code with Prettier"
	@echo "  npm version patch    Bump patch version (0.0.x)"
	@echo "  npm version minor    Bump minor version (0.x.0)"
	@echo "  npm version major    Bump major version (x.0.0)"
	@echo ""
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(YELLOW)Tip:$(NC) Run $(GREEN)make <command>$(NC) to execute any command above"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"

clean:
	@echo "$(BLUE)Cleaning build artifacts...$(NC)"
	rm -rf dist/
	rm -rf *.tsbuildinfo
	rm -rf node_modules/.cache
	@echo "$(GREEN)✓ Clean complete$(NC)"
	@echo "$(YELLOW)Tip: Run 'make clean-env' to also remove Python virtual environment$(NC)"

rebuild: clean
	@echo "$(BLUE)Building project...$(NC)"
	pnpm run build
	@echo "$(GREEN)✓ Build complete$(NC)"

link:
	@echo "$(BLUE)Building project...$(NC)"
	pnpm run build
	@echo "$(BLUE)Linking package globally...$(NC)"
	npm link
	@echo "$(BLUE)Setting up n8n custom directory...$(NC)"
	@mkdir -p $(N8N_CUSTOM_DIR)
	@if [ ! -f $(N8N_CUSTOM_DIR)/package.json ]; then \
		cd $(N8N_CUSTOM_DIR) && npm init -y; \
	fi
	@echo "$(BLUE)Linking package to n8n...$(NC)"
	cd $(N8N_CUSTOM_DIR) && npm link $(PACKAGE_NAME)
	@echo "$(GREEN)✓ Package linked successfully$(NC)"
	@echo "$(YELLOW)Run 'make run' to start n8n$(NC)"

unlink:
	@echo "$(BLUE)Unlinking package...$(NC)"
	@if [ -d $(N8N_CUSTOM_DIR) ]; then \
		cd $(N8N_CUSTOM_DIR) && npm unlink $(PACKAGE_NAME) 2>/dev/null || true; \
	fi
	npm unlink -g 2>/dev/null || true
	@echo "$(GREEN)✓ Package unlinked$(NC)"

run: rebuild fix-permissions
	@echo "$(BLUE)Starting n8n with your node...$(NC)"
	@if [ -f .env.n8n ]; then \
		export $$(cat .env.n8n | grep -v '^#' | xargs) && n8n start; \
	else \
		n8n start; \
	fi

stop:
	@echo "$(BLUE)Stopping n8n...$(NC)"
	@pkill -f "n8n start" || true
	@echo "$(GREEN)✓ n8n stopped$(NC)"

test: link run

fix-permissions:
	@if [ -f $(HOME)/.n8n/config ]; then \
		chmod 600 $(HOME)/.n8n/config 2>/dev/null || true; \
	fi

##########################################################################################
### PYTHON VIRTUAL ENVIRONMENT
##########################################################################################

env:
	$(call PRINT_TITLE,"Creating virtual environment for documentation")
	@if [ ! -d "$(VIRTUAL_ENV)" ]; then \
		echo "$(YELLOW)Creating Python virtual env in $(VIRTUAL_ENV)$(NC)"; \
		python$(PYTHON_VERSION) -m venv "$(VIRTUAL_ENV)" 2>/dev/null || python3 -m venv "$(VIRTUAL_ENV)"; \
		echo "$(GREEN)✓ Virtual environment created$(NC)"; \
	else \
		echo "$(GREEN)✓ Python virtual env already exists in $(VIRTUAL_ENV)$(NC)"; \
	fi
	@echo "$(YELLOW)Installing documentation dependencies...$(NC)"
	@$(VENV_PIP) install --upgrade pip >/dev/null
	@$(VENV_PIP) install mkdocs-material mkdocs-glightbox >/dev/null
	@echo "$(GREEN)✓ Dependencies installed$(NC)"
	@echo ""
	@echo "Using Python: $$($(VENV_PYTHON) --version) from $(VENV_PYTHON)"
	@echo "Using MkDocs: $$($(VENV_MKDOCS) --version)"
	@echo ""

clean-env:
	$(call PRINT_TITLE,"Removing virtual environment")
	@if [ -d "$(VIRTUAL_ENV)" ]; then \
		rm -rf "$(VIRTUAL_ENV)"; \
		echo "$(GREEN)✓ Virtual environment removed$(NC)"; \
	else \
		echo "$(YELLOW)No virtual environment to remove$(NC)"; \
	fi

##########################################################################################
### DOCUMENTATION
##########################################################################################

docs: env
	$(call PRINT_TITLE,"Serving documentation locally")
	@$(VENV_MKDOCS) serve --watch docs

docs-check: env
	$(call PRINT_TITLE,"Checking documentation build")
	@$(VENV_MKDOCS) build --strict
	@echo "$(GREEN)✓ Documentation build successful$(NC)"

docs-deploy: env
	$(call PRINT_TITLE,"Deploying documentation to GitHub Pages")
	@$(VENV_MKDOCS) gh-deploy --force --clean
	@echo "$(GREEN)✓ Documentation deployed to GitHub Pages$(NC)"
