FROM node:18 AS builder
  WORKDIR /usr/src/app

  COPY media-scanner/package.json media-scanner/pnpm-lock.yaml ./
  RUN sed -i -e 's/^		"version": "[0-9.]\+",$//' package.json
  RUN corepack enable pnpm

  COPY media-scanner/src ./src
  COPY media-scanner/tsconfig.build.json ./

  RUN pnpm install --frozen-lockfile
  RUN pnpm run build:ts

  RUN sed -i -e 's/^		"postinstall": "husky",$//' package.json
  RUN pnpm prune --prod

FROM node:18
  WORKDIR /usr/src/app
  ENV NODE_ENV=production
  ENV PATHS__FFMPEG=ffmpeg
  ENV PATHS__FFPROBE=ffprobe

  RUN apt-get update && \
      apt-get install ffmpeg curl -y && \
      rm -rf /var/lib/apt/lists/* && \
      which ffmpeg && \
      which ffprobe && \
      echo "FFmpeg version:" && ffmpeg -version && \
      echo "FFprobe version:" && ffprobe -version

  COPY --from=builder /usr/src/app/package.json ./
  COPY --from=builder /usr/src/app/dist ./dist
  COPY --from=builder /usr/src/app/node_modules ./node_modules
  
  # Config file will be mounted from host at runtime
     
  CMD [ "node", "dist" ]
  HEALTHCHECK CMD curl -f http://localhost:8000/healthcheck || exit 1
