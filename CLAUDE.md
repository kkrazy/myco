# Mycelium — Claude Code Instructions

## Pre-Commit

1. **Always run `./test.sh` before committing.** Fix any failures before proceeding with the commit.

## Deployment

1. **Always deploy to `myco.labxnow.ai` via the Docker image.** Build and ship the container — never push raw source or `systemctl restart` directly on the remote host.

## Design Guidelines

1. **Always use Mermaid diagrams** for any architecture, flow, sequence, or state diagrams. Never use ASCII art boxes or plain-text diagrams.
