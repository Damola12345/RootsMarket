# Build Stage 
FROM node:22-alpine AS builder

# Set the working directory inside the container
WORKDIR /app

# Build-time env variables used by Vite
ARG VITE_USER_SERVICE_URL
ARG VITE_PRODUCT_SERVICE_URL
ARG VITE_ORDER_SERVICE_URL
ARG VITE_PAYMENT_SERVICE_URL
ARG VITE_NOTIFICATION_SERVICE_URL

# Expose build arguments as env variables
ENV VITE_USER_SERVICE_URL=$VITE_USER_SERVICE_URL
ENV VITE_PRODUCT_SERVICE_URL=$VITE_PRODUCT_SERVICE_URL
ENV VITE_ORDER_SERVICE_URL=$VITE_ORDER_SERVICE_URL
ENV VITE_PAYMENT_SERVICE_URL=$VITE_PAYMENT_SERVICE_URL
ENV VITE_NOTIFICATION_SERVICE_URL=$VITE_NOTIFICATION_SERVICE_URL

# Copy dependency definitions first to leverage Docker layer caching
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the app source
COPY . .

# Generate the optimized production build
RUN npm run build


# Final Stage  Serve the app with Nginx
FROM nginx:alpine

# Replace the default Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copy the compiled React app from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose the HTTP port
EXPOSE 80

# Start Nginx in the foreground
CMD ["nginx", "-g", "daemon off;"]