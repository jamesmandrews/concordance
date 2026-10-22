FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source edit does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY db ./db
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "src/server.js"]
