#!/bin/bash

###############################################################################
# Cloudflare Tunnel Setup Script for VGit2
#
# This script creates a single named Cloudflare tunnel that handles multiple
# local ports (5173, 5174, 5175, 8080, 8000, 3000, 4200) with stable URLs.
#
# Usage:
#   ./scripts/setup-cloudflare-tunnel.sh
#
# Requirements:
#   - cloudflared CLI installed
#   - Cloudflare account with domain DNS managed by Cloudflare
#   - Domain name for tunnel hostnames
###############################################################################

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Ports to configure (from MODAL_EXTRA_PORTS)
PORTS=(5173 5174 5175 8080 8000 3000 4200)

###############################################################################
# Helper Functions
###############################################################################

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

###############################################################################
# Check Prerequisites
###############################################################################

check_prerequisites() {
    print_header "Checking Prerequisites"

    # Check if cloudflared is installed
    if ! command -v cloudflared &> /dev/null; then
        print_error "cloudflared is not installed"
        echo ""
        echo "Install cloudflared:"
        echo "  macOS:   brew install cloudflared"
        echo "  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        echo ""
        exit 1
    fi
    print_success "cloudflared is installed ($(cloudflared --version))"

    # Check if jq is installed (for JSON parsing)
    if ! command -v jq &> /dev/null; then
        print_warning "jq is not installed (optional, but recommended)"
        echo "  Install: brew install jq (macOS) or apt-get install jq (Linux)"
    else
        print_success "jq is installed"
    fi

    # Check if logged in to Cloudflare
    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
        print_warning "Not logged in to Cloudflare"
        echo ""
        read -p "Would you like to login now? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cloudflared tunnel login
            if [ $? -eq 0 ]; then
                print_success "Successfully logged in to Cloudflare"
            else
                print_error "Failed to login to Cloudflare"
                exit 1
            fi
        else
            print_error "Please login first: cloudflared tunnel login"
            exit 1
        fi
    else
        print_success "Already logged in to Cloudflare"
    fi

    echo ""
}

###############################################################################
# Get Configuration
###############################################################################

get_configuration() {
    print_header "Configuration"

    # Get tunnel name
    read -p "Enter tunnel name (default: portable-dev-tunnel): " TUNNEL_NAME
    TUNNEL_NAME=${TUNNEL_NAME:-portable-dev-tunnel}
    print_info "Tunnel name: $TUNNEL_NAME"

    # Get domain
    read -p "Enter your domain name (default: videogame.ai): " DOMAIN
    DOMAIN=${DOMAIN:-videogame.ai}
    print_info "Domain: $DOMAIN"

    # Confirm
    echo ""
    echo "Configuration Summary:"
    echo "  Tunnel Name: $TUNNEL_NAME"
    echo "  Domain:      $DOMAIN"
    echo "  Ports:       ${PORTS[*]}"
    echo "  Hostnames:   portable-5173.$DOMAIN, portable-5174.$DOMAIN, ..."
    echo ""
    read -p "Continue? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Aborted by user"
        exit 0
    fi
    echo ""
}

###############################################################################
# Create Tunnel
###############################################################################

create_tunnel() {
    print_header "Creating Cloudflare Tunnel"

    # Check if tunnel already exists
    if cloudflared tunnel info "$TUNNEL_NAME" &> /dev/null; then
        print_warning "Tunnel '$TUNNEL_NAME' already exists"
        read -p "Use existing tunnel? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            TUNNEL_UUID=$(cloudflared tunnel info "$TUNNEL_NAME" -o json | jq -r '.id' 2>/dev/null || cloudflared tunnel info "$TUNNEL_NAME" | grep -oP 'Your tunnel \K[a-f0-9-]+')
            print_success "Using existing tunnel: $TUNNEL_UUID"
        else
            print_info "Please delete the existing tunnel first or choose a different name"
            exit 1
        fi
    else
        # Create tunnel
        print_info "Creating tunnel..."
        OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1)

        if [ $? -eq 0 ]; then
            # Extract tunnel UUID from output
            TUNNEL_UUID=$(echo "$OUTPUT" | grep -oP 'Created tunnel .* with id \K[a-f0-9-]+' || echo "$OUTPUT" | grep -oP 'tunnel \K[a-f0-9-]+')
            print_success "Tunnel created: $TUNNEL_UUID"
        else
            print_error "Failed to create tunnel"
            echo "$OUTPUT"
            exit 1
        fi
    fi

    # Get tunnel token
    print_info "Getting tunnel token..."
    TUNNEL_TOKEN=$(cloudflared tunnel token "$TUNNEL_UUID" 2>/dev/null || cloudflared tunnel token "$TUNNEL_NAME" 2>/dev/null)

    if [ -z "$TUNNEL_TOKEN" ]; then
        print_error "Failed to get tunnel token"
        exit 1
    fi
    print_success "Tunnel token retrieved"

    echo ""
}

###############################################################################
# Create Config File
###############################################################################

create_config() {
    print_header "Creating Tunnel Configuration"

    CONFIG_DIR="$HOME/.cloudflared"
    CONFIG_FILE="$CONFIG_DIR/portable-config.yml"

    mkdir -p "$CONFIG_DIR"

    # Create config.yml with ingress rules
    cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_UUID
credentials-file: $CONFIG_DIR/$TUNNEL_UUID.json

ingress:
EOF

    # Add ingress rules for each port
    for PORT in "${PORTS[@]}"; do
        echo "  - hostname: portable-$PORT.$DOMAIN" >> "$CONFIG_FILE"
        echo "    service: http://localhost:$PORT" >> "$CONFIG_FILE"
    done

    # Add catch-all rule (required)
    echo "  - service: http_status:404" >> "$CONFIG_FILE"

    print_success "Config file created: $CONFIG_FILE"

    # Show config
    print_info "Configuration:"
    cat "$CONFIG_FILE"
    echo ""
}

###############################################################################
# Setup DNS Records
###############################################################################

setup_dns() {
    print_header "Setting Up DNS Records"

    print_info "Creating CNAME records for each port..."

    for PORT in "${PORTS[@]}"; do
        HOSTNAME="portable-$PORT"

        # Try to create DNS record
        OUTPUT=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME.$DOMAIN" 2>&1)

        if echo "$OUTPUT" | grep -q "Created CNAME"; then
            print_success "$HOSTNAME.$DOMAIN → $TUNNEL_UUID.cfargotunnel.com"
        elif echo "$OUTPUT" | grep -q "already exists"; then
            print_warning "$HOSTNAME.$DOMAIN already exists (skipping)"
        else
            print_error "Failed to create DNS for $HOSTNAME.$DOMAIN"
            echo "$OUTPUT"
        fi
    done

    echo ""
}

###############################################################################
# Test Tunnel
###############################################################################

test_tunnel() {
    print_header "Testing Tunnel"

    print_info "Starting tunnel in background for 5 seconds..."

    # Start tunnel in background
    cloudflared tunnel --config "$HOME/.cloudflared/portable-config.yml" run &
    TUNNEL_PID=$!

    # Wait for tunnel to start
    sleep 5

    # Check if process is still running
    if ps -p $TUNNEL_PID > /dev/null; then
        print_success "Tunnel is running (PID: $TUNNEL_PID)"

        # Stop the tunnel
        kill $TUNNEL_PID 2>/dev/null
        wait $TUNNEL_PID 2>/dev/null
        print_success "Tunnel stopped"
    else
        print_error "Tunnel failed to start"
    fi

    echo ""
}

###############################################################################
# Output Environment Variables
###############################################################################

output_env_vars() {
    print_header "Environment Variables"

    echo "Add these to your .env file:"
    echo ""
    echo "# Stable Cloudflare Tunnels"
    echo "USE_STABLE_TUNNELS=true"
    echo "CLOUDFLARE_TUNNEL_UUID=$TUNNEL_UUID"
    echo "CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN"
    echo "CLOUDFLARE_TUNNEL_DOMAIN=$DOMAIN"
    echo ""

    print_success "Setup complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Add the environment variables above to your .env file"
    echo "  2. Restart your development server: bun run dev"
    echo "  3. Tunnels will be created at: https://portable-{PORT}.$DOMAIN"
    echo ""
    echo "To run the tunnel manually:"
    echo "  cloudflared tunnel --config $HOME/.cloudflared/portable-config.yml run"
    echo ""
}

###############################################################################
# Main
###############################################################################

main() {
    print_header "VGit2 Cloudflare Tunnel Setup"

    check_prerequisites
    get_configuration
    create_tunnel
    create_config
    setup_dns
    test_tunnel
    output_env_vars
}

main "$@"
