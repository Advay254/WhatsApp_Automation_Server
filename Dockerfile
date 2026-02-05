# Use Node 18 Alpine as the base
FROM node:18-alpine

# Install git (needed for fetching some npm dependencies)
RUN apk add --no-cache git

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app code
COPY . .

# Open the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
