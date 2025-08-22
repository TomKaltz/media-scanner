FROM node:18 AS builder
  WORKDIR /usr/src/app

  COPY media-scanner/package.json media-scanner/yarn.lock media-scanner/.yarnrc.yml ./
  RUN sed -i -e 's/^		"version": "[0-9.]\+",$//' package.json
  RUN corepack enable

  COPY media-scanner/src ./src
  COPY media-scanner/tsconfig.build.json ./

  RUN yarn install
  RUN yarn build:ts

  RUN sed -i -e 's/^		"postinstall": "husky",$//' package.json
  RUN yarn workspaces focus --production

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
  
  # Copy config file during build
  COPY tkcg/src/shell/casparcg.config ./casparcg.config
     
  CMD [ "node", "dist" ]
  HEALTHCHECK CMD curl -f http://localhost:8000/healthcheck || exit 1
