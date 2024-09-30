# Step 1: Use Node.js official image
FROM node:18

# Step 2: Set the working directory inside the container
WORKDIR /app

# Step 3: Copy package.json and package-lock.json and install dependencies
COPY package*.json ./
RUN npm install

# Step 4: Copy the rest of your app into the container
COPY . .

# Step 5: Expose the app's port (make sure this is the same port your app is running on)
EXPOSE 3100

# Step 6: Start the app with npm start (assuming your package.json has the start script)
CMD ["npm", "start"]
