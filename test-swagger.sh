#!/bin/bash

# Hypertron API - Swagger Documentation Tester
# Tests Swagger UI accessibility and generates a report

API_URL="https://hypertron-api.onrender.com"
LOCAL_URL="http://localhost:3000"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_FILE="swagger-test-report-${TIMESTAMP}.md"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "================================"
echo "  SWAGGER DOCUMENTATION TEST"
echo "================================"
echo ""

# Initialize report
cat > "$REPORT_FILE" << 'EOF'
# Swagger Documentation Test Report

**Generated:** $(date)

---

## Test Results

EOF

# Test function
test_swagger_endpoint() {
    local name="$1"
    local url="$2"
    local endpoint="$3"
    
    echo -e "${BLUE}Testing: $name${NC}"
    echo "### $name" >> "$REPORT_FILE"
    echo "- **URL:** $url$endpoint" >> "$REPORT_FILE"
    
    local response=$(curl -s -o /dev/null -w "%{http_code}" "$url$endpoint")
    
    if [ "$response" = "200" ]; then
        echo -e "${GREEN}✓ PASS${NC} - Status: $response"
        echo "- **Status:** $response ✅" >> "$REPORT_FILE"
        echo "- **Result:** PASS" >> "$REPORT_FILE"
        return 0
    elif [ "$response" = "502" ] || [ "$response" = "503" ]; then
        echo -e "${YELLOW}⚠ WARNING${NC} - Status: $response (Service may need SWAGGER_ENABLED=true)"
        echo "- **Status:** $response ⚠️" >> "$REPORT_FILE"
        echo "- **Result:** NEEDS CONFIGURATION" >> "$REPORT_FILE"
        echo "- **Fix:** Add \`SWAGGER_ENABLED=true\` to Render environment variables" >> "$REPORT_FILE"
        return 1
    else
        echo -e "${RED}✗ FAIL${NC} - Status: $response"
        echo "- **Status:** $response ❌" >> "$REPORT_FILE"
        echo "- **Result:** FAIL" >> "$REPORT_FILE"
        return 1
    fi
    
    echo "" >> "$REPORT_FILE"
}

# Test Swagger UI
echo ""
echo "Testing Production Swagger UI..."
test_swagger_endpoint "Production Swagger UI" "$API_URL" "/docs"
prod_ui_result=$?

echo ""
echo "Testing Production OpenAPI JSON..."
test_swagger_endpoint "Production OpenAPI JSON" "$API_URL" "/docs-json"
prod_json_result=$?

# Check if local server is running
echo ""
echo "Checking if local server is running..."
if curl -s -o /dev/null -w "%{http_code}" "$LOCAL_URL" | grep -q "200"; then
    echo -e "${GREEN}✓${NC} Local server detected"
    
    echo ""
    echo "Testing Local Swagger UI..."
    test_swagger_endpoint "Local Swagger UI" "$LOCAL_URL" "/docs"
    local_ui_result=$?
    
    echo ""
    echo "Testing Local OpenAPI JSON..."
    test_swagger_endpoint "Local OpenAPI JSON" "$LOCAL_URL" "/docs-json"
    local_json_result=$?
else
    echo -e "${YELLOW}⚠${NC} Local server not running (this is OK)"
    echo ""
    echo "### Local Server" >> "$REPORT_FILE"
    echo "- **Status:** Not running (optional)" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
fi

# Add recommendations to report
cat >> "$REPORT_FILE" << 'EOF'

---

## Recommendations

### If Swagger is not accessible in production:

1. **Enable Swagger in Render:**
   ```bash
   # Add environment variable in Render Dashboard
   SWAGGER_ENABLED=true
   ```

2. **Redeploy the service:**
   - Go to Render Dashboard
   - Select hypertron-api service
   - Click "Manual Deploy" → "Deploy latest commit"
   - Or push a new commit to trigger deployment

3. **Verify access:**
   ```bash
   curl -I https://hypertron-api.onrender.com/docs
   # Should return HTTP/2 200
   ```

4. **Test in browser:**
   - Open: https://hypertron-api.onrender.com/docs
   - Should see Swagger UI interface

### Security Considerations for Production Swagger:

1. **IP Whitelisting (Recommended):**
   - Restrict Swagger UI access to trusted IPs
   - Use Render's network policies

2. **Basic Authentication:**
   - Add middleware to protect /docs endpoint
   - Require username/password

3. **Disable in Production:**
   - Set `SWAGGER_ENABLED=false` in production
   - Keep enabled only in staging/development

### Testing Swagger Locally:

```bash
# Install dependencies
npm install

# Start dev server
npm run start:dev

# Open Swagger UI
open http://localhost:3000/docs

# Or generate static spec
npx ts-node scripts/generate-openapi-spec.ts
```

---

## Swagger UI Features

When Swagger is accessible, you can:

1. **Explore all endpoints** - Browse by category
2. **Test API calls** - Try it out directly from browser
3. **View request/response schemas** - See all data models
4. **Authenticate** - Use Bearer token or cookies
5. **Generate code** - Export for various languages
6. **Download spec** - Save OpenAPI JSON/YAML

---

## Next Steps

1. ✅ Enable Swagger in production (if needed)
2. ✅ Test all endpoint categories
3. ✅ Verify authentication methods work
4. ✅ Document for team
5. ✅ Generate client SDKs (optional)

---

EOF

# Summary
echo ""
echo "================================"
echo "  TEST SUMMARY"
echo "================================"
echo ""

if [ $prod_ui_result -eq 0 ] && [ $prod_json_result -eq 0 ]; then
    echo -e "${GREEN}✓ All production tests passed!${NC}"
    echo ""
    echo "Swagger UI is accessible at:"
    echo "  $API_URL/docs"
else
    echo -e "${YELLOW}⚠ Swagger UI needs configuration${NC}"
    echo ""
    echo "To enable Swagger in production:"
    echo "  1. Go to Render Dashboard"
    echo "  2. Add environment variable: SWAGGER_ENABLED=true"
    echo "  3. Redeploy the service"
    echo "  4. Test again: $API_URL/docs"
fi

echo ""
echo "Full report saved to: $REPORT_FILE"
echo ""

# Offer to open URLs
if [ $prod_ui_result -eq 0 ]; then
    read -p "Open production Swagger UI in browser? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if command -v open &> /dev/null; then
            open "$API_URL/docs"
        elif command -v xdg-open &> /dev/null; then
            xdg-open "$API_URL/docs"
        else
            echo "Please open manually: $API_URL/docs"
        fi
    fi
fi

exit 0
