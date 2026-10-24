FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_OPTIONS=--no-warnings
ENV PORT=8080
EXPOSE 8080
VOLUME /app/data
CMD ["node", "src/server.js"]
