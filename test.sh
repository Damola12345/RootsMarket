# for i in {1..10}; do
#   curl -s http://localhost:3002/products > /dev/null
# done

USER_ID=$(curl -s http://localhost:3001/users | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
PRODUCT_ID=$(curl -s http://localhost:3002/products | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
echo "user=$USER_ID product=$PRODUCT_ID"

curl -s -X POST http://localhost:3003/orders \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}"

sleep 5
docker compose logs --since 60s order-service payment-service notification-service \
  | grep -E 'order_created_event_published|payment_completed_event_published|notification_sent'