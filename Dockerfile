FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

# Os dados ficam no PostgreSQL (DATABASE_URL), não em volume local.
CMD ["node", "server.js"]