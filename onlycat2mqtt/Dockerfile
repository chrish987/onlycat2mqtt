FROM node:24.5.0-alpine3.22
WORKDIR /app
COPY package.json ./
RUN npm install
RUN npm install socket.io-client
RUN npm install mqtt
RUN npm install winston
RUN npm install moment
COPY . .
CMD ["node", "app.js"]
