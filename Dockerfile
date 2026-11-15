FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/public/uploads

EXPOSE 3000

CMD ["node", "server.js"]
